import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runUp } from "../bin/commands/up.mjs";
import { resolveOAuthClientConfig, saveOAuthCredentials } from "../bin/lib/colab-oauth.mjs";
import { appendLedgerEvent, readLedgerEvents } from "../bin/lib/credit-ledger.mjs";
import { createPanelActions } from "../bin/lib/panel-actions.mjs";
import { listSessions, writeSession } from "../bin/lib/session-store.mjs";

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

const NOW = "2026-11-20T12:00:00.000Z";
const RUNTIME = { id: "r-9", endpoint: "r-9", baseUrl: "https://8080-m.colab.dev", token: "proxy-tok", tokenExpiry: null };

// 10 hours on a T4 this month: an estimated 19.6 CU.
function seedMonthlyUse(homeDir, budgetCu) {
  appendLedgerEvent({ type: "session.start", at: "2026-11-10T00:00:00.000Z", session: "orca-colab-old", account: "default", rateKey: "T4", cuPerHour: 1.96 }, homeDir);
  appendLedgerEvent({ type: "session.end", at: "2026-11-10T10:00:00.000Z", session: "orca-colab-old", account: "default", cause: "user" }, homeDir);
  if (budgetCu !== null) {
    appendLedgerEvent({ type: "budget.set", at: "2026-11-01T00:00:00.000Z", account: "default", budgetCu }, homeDir);
  }
}

function upWithFakes(argv, homeDir, assigned) {
  saveOAuthCredentials(
    "default",
    { refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 3_600_000, clientId: resolveOAuthClientConfig(homeDir).clientId },
    homeDir,
  );
  const io = makeBuffers();
  return runUp(argv, {
    json: true,
    stdout: io.stdout,
    stderr: io.stderr,
    env: {},
    homeDir,
    nowMs: () => Date.parse(NOW),
    nowIso: () => NOW,
    assignRuntimeFn: async () => {
      assigned.push("assign");
      return RUNTIME;
    },
    queryGpuTtyFn: async () => ({ name: "Tesla T4", memoryTotalMiB: 15360, driverVersion: null }),
  });
}

test("up refuses a new runtime once the estimated monthly use has reached the budget", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-up-budget-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));
  seedMonthlyUse(tmpHome, 19.6);

  const assigned = [];
  await assert.rejects(
    () => upWithFakes(["--gpu", "T4"], tmpHome, assigned),
    (err) => {
      assert.equal(err.exitCode, 1);
      assert.deepEqual(err.payload, {
        ok: false,
        code: "BUDGET_REACHED",
        error:
          "Monthly compute-unit budget reached for account 'default': about 19.6 of 19.6 CU used this month (estimate). No new runtime was started.",
        account: "default",
        approximate: true,
        budgetCu: 19.6,
        estimatedMonthlyUsedCu: 19.6,
        estimatedBudgetUsedPercent: 100,
        hint: "Only the owner can raise the monthly budget: under Guardrails & CU in the Colab GPU panel, or with 'orca-colab credits budget <cu>' (0 removes the limit).",
        step: "budget",
      });
      return true;
    },
  );
  assert.deepEqual(assigned, []);
  assert.deepEqual(listSessions(tmpHome), []);

  await assert.rejects(
    () => createPanelActions({ homeDir: tmpHome }).startSession({ gpu: "T4" }),
    /about 19\.6 of 19\.6 CU used this month \(estimate\)\. No new runtime was started\. Raise the monthly budget under Guardrails & CU/,
  );
});

test("the budget does not stop reusing a running session, and --new on top of it is refused", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-up-budget-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));
  seedMonthlyUse(tmpHome, 10);
  writeSession({ name: "orca-colab-live", account: "default", createdAt: NOW, rateKey: "T4", cuPerHour: 1.96, colabRuntime: RUNTIME }, tmpHome);

  const assigned = [];
  assert.equal(await upWithFakes(["--gpu", "T4", "--name", "live"], tmpHome, assigned), 0);
  assert.deepEqual(assigned, ["assign"]);
  assert.deepEqual(listSessions(tmpHome).map((s) => [s.name, s.state]), [["orca-colab-live", "active"]]);

  await assert.rejects(
    () => upWithFakes(["--gpu", "T4", "--new", "--name", "second"], tmpHome, assigned),
    (err) => err.payload.step === "budget" && err.payload.budgetCu === 10,
  );
  assert.deepEqual(assigned, ["assign"]);
});

test("up starts a runtime when use is under the budget, when no budget is set and when it is 0", async (t) => {
  for (const budgetCu of [19.61, null, 0]) {
    const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-up-budget-"));
    t.after(() => rmSync(tmpHome, { recursive: true, force: true }));
    seedMonthlyUse(tmpHome, budgetCu);
    const assigned = [];
    assert.equal(await upWithFakes(["--gpu", "T4"], tmpHome, assigned), 0, `budget ${budgetCu}`);
    assert.deepEqual(assigned, ["assign"]);
    assert.equal(readLedgerEvents(tmpHome).at(-1).type, "session.start");
  }
});
