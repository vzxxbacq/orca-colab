import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./cli-output.mjs";
import { ALL_GPU_TIERS, readConfig, resolveAgentPolicy, writeJsonAtomic } from "./colab-home.mjs";

// Guardrails for work started from one project live in the project, in Orca's hidden folder, so they
// travel with it to whatever machine it is on (a laptop, an Orca server) and can be shared through git.
// The machine's ~/.orca-colab/config.json stays the default for everything the file does not set.
export const PROJECT_GUARDRAILS_DIR = ".orca";
export const PROJECT_GUARDRAILS_FILE = "colab.json";

const FILE_HEADER = [
  "// Colab GPU guardrails for work started from this project (orca-colab).",
  "// Every field is optional; what is left out comes from this machine's ~/.orca-colab/config.json.",
  "//   allowedGpus            GPU tiers agents may start here: T4, L4, A100, G4, H100, CPU",
  "//   maxConcurrentSessions  runtimes started from this project that may run at once",
  "//   monthlyBudgetCu        hard limit on this project's estimated compute units per month, as counted",
  "//                          on the machine that starts the runtimes (not per Google account)",
  "//   autoStopIdleMinutes    idle minutes before a panel stops a runtime of this project; 0 = never",
];

// Whole-line `//` comments are allowed; nothing else beyond JSON is.
function parseCommentedJson(text) {
  return JSON.parse(
    text
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n"),
  );
}

// The nearest `.orca/colab.json` at or above `startDir`; the folder that holds `.orca` is the project.
export function findProjectGuardrails(startDir) {
  if (!startDir) return null;
  let dir = path.resolve(startDir);
  for (;;) {
    const file = path.join(dir, PROJECT_GUARDRAILS_DIR, PROJECT_GUARDRAILS_FILE);
    if (existsSync(file)) {
      return { project: dir, file };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function invalid(file, detail) {
  // A guardrails file that cannot be read must stop work, not let it run unguarded.
  return new CliError(`Project guardrails file ${file} is not valid: ${detail}. Fix or remove it.`, {
    payload: { ok: false, error: `Project guardrails file ${file} is not valid: ${detail}. Fix or remove it.`, step: "policy", file },
  });
}

export function readProjectGuardrailsFile(file) {
  let raw;
  try {
    raw = parseCommentedJson(readFileSync(file, "utf8"));
  } catch (err) {
    throw invalid(file, err instanceof Error ? err.message : String(err));
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid(file, "it must hold one JSON object");
  }
  const values = {};
  if (raw.allowedGpus !== undefined) {
    const gpus = Array.isArray(raw.allowedGpus) ? raw.allowedGpus.map((g) => String(g).trim().toUpperCase()) : null;
    if (!gpus || gpus.length === 0 || gpus.some((g) => !ALL_GPU_TIERS.includes(g))) {
      throw invalid(file, `allowedGpus must be a non-empty list out of ${ALL_GPU_TIERS.join(", ")}`);
    }
    values.allowedGpus = gpus;
  }
  if (raw.maxConcurrentSessions !== undefined) {
    if (!Number.isInteger(raw.maxConcurrentSessions) || raw.maxConcurrentSessions < 1) {
      throw invalid(file, "maxConcurrentSessions must be a whole number of 1 or more");
    }
    values.maxConcurrentSessions = raw.maxConcurrentSessions;
  }
  if (raw.monthlyBudgetCu !== undefined) {
    if (typeof raw.monthlyBudgetCu !== "number" || !Number.isFinite(raw.monthlyBudgetCu) || raw.monthlyBudgetCu < 0) {
      throw invalid(file, "monthlyBudgetCu must be a number of 0 or more");
    }
    // 0 means "no budget of its own", like leaving it out.
    if (raw.monthlyBudgetCu > 0) values.monthlyBudgetCu = raw.monthlyBudgetCu;
  }
  if (raw.autoStopIdleMinutes !== undefined) {
    if (!Number.isInteger(raw.autoStopIdleMinutes) || raw.autoStopIdleMinutes < 0) {
      throw invalid(file, "autoStopIdleMinutes must be a whole number of 0 or more");
    }
    values.autoStopIdleMinutes = raw.autoStopIdleMinutes;
  }
  return values;
}

// The guardrails in force for work started from `cwd`: the project file's values over the machine's.
// `source` is "project" when a file was found (`setByProject` names the fields it sets), else "machine".
// `monthlyBudgetCu` and `autoStopIdleMinutes` are null unless the project file sets them: the machine's
// budget is kept per Google account in the ledger and its idle minutes in the plugin's settings.
export function resolveGuardrails({ cwd = null, homeDir = os.homedir() } = {}) {
  const machine = resolveAgentPolicy(readConfig(homeDir));
  const found = cwd ? findProjectGuardrails(cwd) : null;
  if (!found) {
    return {
      ...machine,
      monthlyBudgetCu: null,
      autoStopIdleMinutes: null,
      source: "machine",
      project: null,
      file: null,
      setByProject: [],
    };
  }
  const values = readProjectGuardrailsFile(found.file);
  return {
    allowedGpus: values.allowedGpus ?? machine.allowedGpus,
    maxConcurrentSessions: values.maxConcurrentSessions ?? machine.maxConcurrentSessions,
    allGpus: machine.allGpus,
    monthlyBudgetCu: values.monthlyBudgetCu ?? null,
    autoStopIdleMinutes: values.autoStopIdleMinutes ?? null,
    source: "project",
    project: found.project,
    file: found.file,
    setByProject: Object.keys(values),
  };
}

// What a runtime's record carries, so a machine that cannot read the project's files can still show
// which guardrails the runtime was started under and where they came from.
export function guardrailsForRecord(guardrails, { machineBudgetCu = null } = {}) {
  return {
    source: guardrails.source,
    file: guardrails.file,
    allowedGpus: guardrails.allowedGpus,
    maxConcurrentSessions: guardrails.maxConcurrentSessions,
    monthlyBudgetCu: guardrails.monthlyBudgetCu ?? (machineBudgetCu > 0 ? machineBudgetCu : null),
    budgetScope: guardrails.monthlyBudgetCu ? "project" : "machine",
    autoStopIdleMinutes: guardrails.autoStopIdleMinutes,
  };
}

export function normalizeRecordedGuardrails(input) {
  if (!input || typeof input !== "object" || (input.source !== "project" && input.source !== "machine")) {
    return null;
  }
  return {
    source: input.source,
    file: typeof input.file === "string" && input.file ? input.file : null,
    allowedGpus: Array.isArray(input.allowedGpus) ? input.allowedGpus.map(String) : [],
    maxConcurrentSessions: Number.isInteger(input.maxConcurrentSessions) ? input.maxConcurrentSessions : null,
    monthlyBudgetCu: typeof input.monthlyBudgetCu === "number" ? input.monthlyBudgetCu : null,
    budgetScope: input.budgetScope === "project" ? "project" : "machine",
    autoStopIdleMinutes: Number.isInteger(input.autoStopIdleMinutes) ? input.autoStopIdleMinutes : null,
  };
}

// Sets or clears fields of the project's file (`null` clears one). The file and `.orca/` are created
// only here, when someone actually sets something; a file left with no field is removed again.
export function updateProjectGuardrails(projectDir, patch = {}) {
  const found = findProjectGuardrails(projectDir);
  const file = found?.file ?? path.join(path.resolve(projectDir), PROJECT_GUARDRAILS_DIR, PROJECT_GUARDRAILS_FILE);
  const next = { ...(found ? readProjectGuardrailsFile(file) : {}) };
  for (const key of ["allowedGpus", "maxConcurrentSessions", "monthlyBudgetCu", "autoStopIdleMinutes"]) {
    if (patch[key] === null || (key === "monthlyBudgetCu" && patch[key] === 0)) {
      delete next[key];
    } else if (patch[key] !== undefined) {
      next[key] = patch[key];
    }
  }
  if (Object.keys(next).length === 0) {
    removeProjectGuardrails(projectDir);
    return { file, removed: true };
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, next, { mode: 0o644, header: FILE_HEADER });
  // Reading it back applies the same checks a hand edit gets.
  readProjectGuardrailsFile(file);
  return { file, removed: false };
}

export function removeProjectGuardrails(projectDir) {
  const found = findProjectGuardrails(projectDir);
  if (!found) return false;
  rmSync(found.file, { force: true });
  const dir = path.dirname(found.file);
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // `.orca/` holds other things or is already gone.
  }
  return true;
}

// For the panel: the project's file as it is, what is in force, and the reason when it cannot be read.
export function describeProjectGuardrails(projectDir, homeDir = os.homedir()) {
  const found = findProjectGuardrails(projectDir);
  const file = found?.file ?? path.join(path.resolve(projectDir), PROJECT_GUARDRAILS_DIR, PROJECT_GUARDRAILS_FILE);
  const base = { project: found?.project ?? path.resolve(projectDir), file, exists: Boolean(found) };
  try {
    const effective = resolveGuardrails({ cwd: projectDir, homeDir });
    return { ...base, values: found ? readProjectGuardrailsFile(file) : {}, effective, error: null };
  } catch (err) {
    return {
      ...base,
      values: {},
      effective: { ...resolveGuardrails({ homeDir }), source: "project", project: base.project, file },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
