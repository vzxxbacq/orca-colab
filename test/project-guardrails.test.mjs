import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runUp } from "../bin/commands/up.mjs";
import { discoverAccountRuntimes } from "../bin/lib/account-runtimes.mjs";
import { writeConfig } from "../bin/lib/colab-home.mjs";
import { resolveOAuthClientConfig, saveOAuthCredentials } from "../bin/lib/colab-oauth.mjs";
import { appendLedgerEvent, readLedgerEvents } from "../bin/lib/credit-ledger.mjs";
import { createOrcaRemoteHelper } from "../bin/lib/orca-remote-helper.mjs";
import { resolveGuardrails, updateProjectGuardrails } from "../bin/lib/project-guardrails.mjs";
import { listSessions, readSession } from "../bin/lib/session-store.mjs";
import { createFakeRuntime, STATE_DIR } from "./fake-colab-runtime.mjs";

const NOW = "2026-11-20T12:00:00.000Z";
const RUNTIME = { id: "r-9", endpoint: "r-9", baseUrl: "https://8080-m.colab.dev", token: "proxy-tok", tokenExpiry: null };

function tmp(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function project(t, fileText) {
  const dir = tmp(t, "orca-colab-project-");
  mkdirSync(path.join(dir, ".orca"));
  mkdirSync(path.join(dir, "src", "train"), { recursive: true });
  writeFileSync(path.join(dir, ".orca", "colab.json"), fileText);
  return dir;
}

function up(argv, { homeDir, cwd, runtime = null, assigned = [] }) {
  saveOAuthCredentials(
    "default",
    { refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 3_600_000, clientId: resolveOAuthClientConfig(homeDir).clientId },
    homeDir,
  );
  let out = "";
  return runUp(argv, {
    json: true,
    stdout: { write: (c) => { out += c; } },
    stderr: { write() {} },
    env: { ORCA_COLAB_MACHINE: "build-server", ORCA_WORKTREE_ID: "folder:f1" },
    cwd,
    homeDir,
    nowMs: () => Date.parse(NOW),
    nowIso: () => NOW,
    ...(runtime ? { fetchImpl: runtime.fetchImpl } : {}),
    assignRuntimeFn: async () => {
      assigned.push("assign");
      return RUNTIME;
    },
    getConsumptionUserInfoFn: async () => ({}),
    queryGpuTtyFn: async () => ({ name: "Colab CPU", memoryTotalMiB: null, driverVersion: null }),
  }).then(() => JSON.parse(out));
}

test("the project's .orca/colab.json is found from a subdirectory and its fields win over the machine config", (t) => {
  const homeDir = tmp(t, "orca-colab-home-");
  writeConfig({ allowedGpus: ["T4", "L4"], maxConcurrentSessions: 3 }, homeDir);
  const dir = project(t, '// shared with the team\n{\n  // CPU only here\n  "allowedGpus": ["cpu"],\n  "monthlyBudgetCu": 5\n}\n');

  assert.deepEqual(resolveGuardrails({ cwd: path.join(dir, "src", "train"), homeDir }), {
    allowedGpus: ["CPU"],
    maxConcurrentSessions: 3,
    allGpus: ["T4", "L4", "A100", "G4", "H100", "CPU"],
    monthlyBudgetCu: 5,
    autoStopIdleMinutes: null,
    source: "project",
    project: dir,
    file: path.join(dir, ".orca", "colab.json"),
    setByProject: ["allowedGpus", "monthlyBudgetCu"],
  });
});

test("without a project file the machine config applies as before and nothing is created", async (t) => {
  const homeDir = tmp(t, "orca-colab-home-");
  writeConfig({ allowedGpus: ["CPU"], maxConcurrentSessions: 1 }, homeDir);
  const dir = tmp(t, "orca-colab-plain-");

  const session = await up(["--gpu", "CPU"], { homeDir, cwd: dir });
  assert.deepEqual(
    { project: session.project ?? null, guardrails: session.guardrails },
    {
      project: null,
      guardrails: { source: "machine", file: null, allowedGpus: ["CPU"], maxConcurrentSessions: 1, monthlyBudgetCu: null, budgetScope: "machine", autoStopIdleMinutes: null },
    },
  );
  assert.equal(existsSync(path.join(dir, ".orca")), false);
  await assert.rejects(up(["--gpu", "T4"], { homeDir, cwd: dir }), /GPU 'T4' is disabled by user policy in Orca Colab settings\. Allowed GPUs: CPU/);
  assert.equal("project" in readLedgerEvents(homeDir)[0], false);
});

test("up refuses a GPU the project does not allow and a new runtime once the project's own budget is used up", async (t) => {
  const homeDir = tmp(t, "orca-colab-home-");
  const dir = project(t, '{ "allowedGpus": ["CPU", "T4"], "monthlyBudgetCu": 5 }');
  const file = path.join(dir, ".orca", "colab.json");
  const other = tmp(t, "orca-colab-other-");
  // 3 hours on a T4 from this project (5.88 CU), 10 hours from another project, and a generous machine budget.
  appendLedgerEvent({ type: "budget.set", at: "2026-11-01T00:00:00.000Z", account: "default", budgetCu: 500 }, homeDir);
  appendLedgerEvent({ type: "session.start", at: "2026-11-10T00:00:00.000Z", session: "orca-colab-a", account: "default", rateKey: "T4", cuPerHour: 1.96, project: dir }, homeDir);
  appendLedgerEvent({ type: "session.end", at: "2026-11-10T03:00:00.000Z", startedAt: "2026-11-10T00:00:00.000Z", session: "orca-colab-a", account: "default", cuPerHour: 1.96, project: dir, cause: "user" }, homeDir);
  appendLedgerEvent({ type: "session.end", at: "2026-11-11T10:00:00.000Z", startedAt: "2026-11-11T00:00:00.000Z", session: "orca-colab-b", account: "default", cuPerHour: 1.96, project: other, cause: "user" }, homeDir);

  const assigned = [];
  await assert.rejects(up(["--gpu", "L4"], { homeDir, cwd: dir, assigned }), (err) => {
    assert.deepEqual(err.payload, {
      ok: false,
      error: `GPU 'L4' is disabled by this project's guardrails (${file}). Allowed GPUs: CPU, T4`,
      allowedGpus: ["CPU", "T4"],
      source: "project",
      file,
      step: "policy",
    });
    return true;
  });
  await assert.rejects(up(["--gpu", "CPU"], { homeDir, cwd: path.join(dir, "src"), assigned }), (err) => {
    assert.deepEqual(err.payload, {
      ok: false,
      code: "BUDGET_REACHED",
      error: `Monthly compute-unit budget reached for this project (${file}): about 5.88 of 5 CU used this month by runtimes started from it on this machine (estimate). No new runtime was started.`,
      scope: "project",
      project: dir,
      file,
      approximate: true,
      budgetCu: 5,
      estimatedMonthlyUsedCu: 5.88,
      estimatedBudgetUsedPercent: 118,
      hint: `Only the owner can raise this project's budget: monthlyBudgetCu in ${file} (or the Guardrails view of the Colab GPU panel on the machine that has the project).`,
      step: "budget",
    });
    return true;
  });
  assert.deepEqual(assigned, []);

  // The other project spent more, but has no budget of its own and the machine's is far away.
  assert.equal((await up(["--gpu", "CPU"], { homeDir, cwd: other, assigned })).name, "orca-colab-r9");
});

test("a project file that cannot be read stops up instead of falling back to the machine config", async (t) => {
  const homeDir = tmp(t, "orca-colab-home-");
  const dir = project(t, '{ "allowedGpus": ["T5"] }');
  const assigned = [];
  await assert.rejects(up(["--gpu", "CPU"], { homeDir, cwd: dir, assigned }), /colab\.json is not valid: allowedGpus must be a non-empty list out of T4, L4, A100, G4, H100, CPU/);
  assert.deepEqual(assigned, []);
});

test("the runtime's record carries the guardrails and their source, and another machine reads them from it", async (t) => {
  const runtime = createFakeRuntime();
  const homeDir = tmp(t, "orca-colab-home-");
  const dir = project(t, '{ "allowedGpus": ["CPU"], "maxConcurrentSessions": 1, "monthlyBudgetCu": 40, "autoStopIdleMinutes": 10 }');
  const file = path.join(dir, ".orca", "colab.json");
  await up(["--gpu", "CPU", "--name", "train"], { homeDir, cwd: dir, runtime });

  const recorded = { source: "project", file, allowedGpus: ["CPU"], maxConcurrentSessions: 1, monthlyBudgetCu: 40, budgetScope: "project", autoStopIdleMinutes: 10 };
  const record = runtime.json(`${STATE_DIR}/session.json`);
  assert.deepEqual(
    { project: record.project, guardrails: record.guardrails, directory: record.origin.directory, orcaWorkspace: record.origin.orcaWorkspace },
    { project: dir, guardrails: recorded, directory: dir, orcaWorkspace: "folder:f1" },
  );
  assert.equal(readLedgerEvents(homeDir).find((e) => e.type === "session.start").project, dir);

  const laptop = tmp(t, "orca-colab-laptop-");
  saveOAuthCredentials("default", { refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 3_600_000, clientId: resolveOAuthClientConfig(laptop).clientId }, laptop);
  await discoverAccountRuntimes({
    homeDir: laptop,
    env: { ORCA_COLAB_MACHINE: "laptop" },
    fetchImpl: runtime.fetchImpl,
    listRuntimesFn: async () => [{ name: "runtimes/r-9", runtimeSpec: { variant: "VARIANT_CPU" }, connectionInfo: { url: RUNTIME.baseUrl, token: RUNTIME.token } }],
  });
  const seen = readSession("orca-colab-train", laptop);
  assert.deepEqual({ adopted: seen.adopted, project: seen.project, guardrails: seen.guardrails }, { adopted: true, project: dir, guardrails: recorded });
  // What the laptop saw of another machine's project never counts against a project of its own.
  assert.equal("project" in readLedgerEvents(laptop).find((e) => e.type === "session.start"), false);
  assert.equal(listSessions(laptop).length, 1);
});

test("the panel's write creates .orca/colab.json only when something is set and removes it when nothing is left", (t) => {
  const dir = tmp(t, "orca-colab-plain-");
  const file = path.join(dir, ".orca", "colab.json");

  assert.deepEqual(updateProjectGuardrails(dir, { monthlyBudgetCu: null }), { file, removed: true });
  assert.equal(existsSync(path.join(dir, ".orca")), false);

  updateProjectGuardrails(dir, { allowedGpus: ["T4"], monthlyBudgetCu: 25 });
  const text = readFileSync(file, "utf8");
  assert.equal(text.startsWith("// Colab GPU guardrails"), true);
  assert.deepEqual(JSON.parse(text.split("\n").filter((l) => !l.startsWith("//")).join("\n")), { allowedGpus: ["T4"], monthlyBudgetCu: 25 });

  updateProjectGuardrails(dir, { allowedGpus: null, monthlyBudgetCu: 0 });
  assert.equal(existsSync(path.join(dir, ".orca")), false);
});

test("opening a server project's file asks each saved server with each selector and keeps the refusals", async () => {
  const calls = [];
  const spawnProcess = (_bin, args) => {
    calls.push(args.join(" "));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const reply =
      args[0] === "environment"
        ? { ok: true, result: { environments: [{ id: "env-lab", name: "lab" }, { id: "env-hk", name: "hk" }] } }
        : args.includes("env-hk") && args.includes("name:train")
          ? { ok: true, result: {} }
          : { ok: false, error: { code: args.includes("env-hk") ? "selector_not_found" : "renderer_unavailable" } };
    setImmediate(() => {
      child.stdout.emit("data", JSON.stringify(reply));
      child.emit("close", reply.ok ? 0 : 1);
    });
    return child;
  };
  const helper = createOrcaRemoteHelper({ orcaBin: "/fake/orca", spawnProcess });
  const opened = await helper.openFileOnServer({ file: "/srv/p/.orca/colab.json", selectors: ["folder:f1", "name:train"] });

  assert.deepEqual(opened, {
    ok: true,
    environment: "hk",
    selector: "name:train",
    attempts: [
      { environment: "lab", selector: "folder:f1", error: "orca file open /srv/p/.orca/colab.json: renderer_unavailable" },
      { environment: "lab", selector: "name:train", error: "orca file open /srv/p/.orca/colab.json: renderer_unavailable" },
      { environment: "hk", selector: "folder:f1", error: "orca file open /srv/p/.orca/colab.json: selector_not_found" },
    ],
  });
  assert.equal(calls.at(-1), "file open /srv/p/.orca/colab.json --worktree name:train --environment env-hk --focus --json");
});
