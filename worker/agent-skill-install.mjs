import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "colab-gpu";
const BUNDLED_SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", SKILL_NAME);
const SKILL_FILES = ["SKILL.md", path.join("references", "cli.md")];

export function agentSkillTargets(homeDir = os.homedir()) {
  return [
    { id: "agents", dir: path.join(homeDir, ".agents", "skills", SKILL_NAME) },
    { id: "claude", dir: path.join(homeDir, ".claude", "skills", SKILL_NAME) },
    { id: "gemini", dir: path.join(homeDir, ".gemini", "config", "skills", SKILL_NAME) },
  ];
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// Only a SKILL.md whose frontmatter names this skill counts as ours; anything else in that folder is left alone.
function isOurSkill(dir) {
  const text = readText(path.join(dir, "SKILL.md"));
  return text !== null && new RegExp(`^---[\\s\\S]*?^name:\\s*${SKILL_NAME}\\s*$`, "m").test(text);
}

export function inspectAgentSkills(homeDir = os.homedir(), bundledDir = BUNDLED_SKILL_DIR) {
  return agentSkillTargets(homeDir).map(({ id, dir }) => {
    const installed = isOurSkill(dir);
    const current =
      installed && SKILL_FILES.every((f) => readText(path.join(dir, f)) === readText(path.join(bundledDir, f)));
    return { id, dir, installed, current, foreign: !installed && existsSync(dir) };
  });
}

function pickTargets(homeDir, ids) {
  const all = agentSkillTargets(homeDir);
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("Choose at least one folder.");
  }
  const picked = all.filter((t) => ids.includes(t.id));
  if (picked.length !== ids.length) {
    throw new Error(`Unknown skill folder: ${ids.filter((id) => !all.some((t) => t.id === id)).join(", ")}`);
  }
  return picked;
}

export function installAgentSkill(ids, homeDir = os.homedir(), bundledDir = BUNDLED_SKILL_DIR) {
  const results = pickTargets(homeDir, ids).map(({ id, dir }) => {
    if (existsSync(dir) && !isOurSkill(dir)) {
      return { id, dir, ok: false, error: "folder exists and is not the colab-gpu skill" };
    }
    try {
      for (const f of SKILL_FILES) {
        const src = path.join(bundledDir, f);
        if (!existsSync(src)) continue;
        mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        copyFileSync(src, path.join(dir, f));
      }
      return { id, dir, ok: true };
    } catch (err) {
      return { id, dir, ok: false, error: err.message };
    }
  });
  return { results, skills: inspectAgentSkills(homeDir, bundledDir) };
}

export function removeAgentSkill(ids, homeDir = os.homedir(), bundledDir = BUNDLED_SKILL_DIR) {
  const results = pickTargets(homeDir, ids).map(({ id, dir }) => {
    if (!existsSync(dir)) return { id, dir, ok: true };
    if (!isOurSkill(dir)) {
      return { id, dir, ok: false, error: "folder is not the colab-gpu skill; left untouched" };
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      return { id, dir, ok: true };
    } catch (err) {
      return { id, dir, ok: false, error: err.message };
    }
  });
  return { results, skills: inspectAgentSkills(homeDir, bundledDir) };
}
