import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run as runCredits } from "../bin/commands/credits.mjs";
import { run as runLedger } from "../bin/commands/ledger.mjs";
import { run as runRates } from "../bin/commands/rates.mjs";
import { projectAccountCredits } from "../bin/lib/credit-ledger.mjs";
import {
  mapGpuNameToRateKey,
  resolveGpuRate,
} from "../bin/lib/rate-table.mjs";

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

test("mapGpuNameToRateKey maps nvidia-smi GPU names and rates command persists user overrides", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-rates-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  assert.equal(mapGpuNameToRateKey("Tesla T4"), "T4");
  assert.equal(mapGpuNameToRateKey("NVIDIA A100-SXM4-40GB"), "A100");
  assert.equal(mapGpuNameToRateKey("NVIDIA L4"), "L4");
  assert.equal(mapGpuNameToRateKey("NVIDIA RTX PRO 6000 Blackwell Server Edition"), "G4");
  assert.equal(mapGpuNameToRateKey("NVIDIA H100 80GB HBM3"), "H100");
  assert.equal(mapGpuNameToRateKey("TPU v2-8"), "TPU v2-8");
  assert.equal(mapGpuNameToRateKey("CPU"), "CPU");
  assert.equal(mapGpuNameToRateKey("Mystery Accelerator"), "unknown");

  assert.deepEqual(resolveGpuRate("Tesla T4", tmpHome), {
    rateKey: "T4",
    cuPerHour: 1.96,
  });

  const io = makeBuffers();
  const code = await runRates(["--set", "T4=2.1"], {
    json: true,
    stdout: io.stdout,
    stderr: io.stderr,
    homeDir: tmpHome,
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(io.stdoutText), {
    approximate: true,
    rates: {
      T4: 2.1,
      L4: 4.82,
      G4: 6.71,
      A100: 11.77,
      H100: 21.2,
      "TPU v2-8": 1.76,
      CPU: 0.08,
      unknown: 2,
    },
  });
  assert.deepEqual(resolveGpuRate("Tesla T4", tmpHome), {
    rateKey: "T4",
    cuPerHour: 2.1,
  });
});

test("projectAccountCredits computes exact balance projection, burn rate, monthly usage and idle waste from hardcoded events", () => {
  const events = [
    {
      type: "budget.set",
      at: "2026-11-01T00:00:00.000Z",
      account: "default",
      budgetCu: 80,
    },
    {
      type: "session.start",
      at: "2026-11-05T10:00:00.000Z",
      account: "default",
      session: "orca-colab-precal",
      gpuName: "Tesla T4",
      rateKey: "T4",
      cuPerHour: 2.0,
    },
    {
      type: "session.end",
      at: "2026-11-05T12:00:00.000Z",
      startedAt: "2026-11-05T10:00:00.000Z",
      account: "default",
      session: "orca-colab-precal",
      rateKey: "T4",
      cuPerHour: 2.0,
      cause: "user",
    },
    {
      type: "calibrate",
      at: "2026-11-07T00:00:00.000Z",
      account: "default",
      balanceCu: 70,
      source: "manual",
    },
    {
      type: "session.start",
      at: "2026-11-08T10:00:00.000Z",
      account: "default",
      session: "orca-colab-postcal",
      gpuName: "Tesla T4",
      rateKey: "T4",
      cuPerHour: 1.96,
    },
    {
      type: "session.end",
      at: "2026-11-08T12:00:00.000Z",
      startedAt: "2026-11-08T10:00:00.000Z",
      account: "default",
      session: "orca-colab-postcal",
      rateKey: "T4",
      cuPerHour: 1.96,
      cause: "idle-watchdog",
    },
  ];

  const activeSessions = [
    {
      name: "orca-colab-live",
      account: "default",
      createdAt: "2026-11-09T00:00:00.000Z",
      cuPerHour: 1.96,
      state: "active",
    },
  ];

  const nowMs = Date.parse("2026-11-09T01:00:00.000Z");
  const projected = projectAccountCredits({
    events,
    activeSessions,
    account: "default",
    nowMs,
    month: "2026-11",
  });

  // Since calibration (70 CU at 2026-11-07T00:00Z):
  // - postcal: 2h * 1.96 = 3.92 CU
  // - live: 1h * 1.96 = 1.96 CU
  // Total burned since calibration = 5.88 CU -> 70 - 5.88 = 64.12 CU
  // Monthly used (all 3 sessions in 2026-11): 4.0 + 3.92 + 1.96 = 9.88 CU
  assert.deepEqual(projected, {
    account: "default",
    approximate: true,
    estimatedBalanceCu: 64.12,
    lastCalibratedAt: "2026-11-07T00:00:00.000Z",
    lastCalibratedBalanceCu: 70,
    calibrationAgeSeconds: 176400,
    estimatedBurnCuPerHour: 1.96,
    estimatedHoursRemaining: 32.71,
    budgetCu: 80,
    estimatedMonthlyUsedCu: 9.88,
    estimatedBudgetUsedPercent: 12.35,
    sessionsThisMonth: 3,
    estimatedWastedIdleCu: 3.92,
  });
});

test("credits set, credits budget and ledger commands append and query JSONL events", async (t) => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "orca-colab-cred-"));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  const io1 = makeBuffers();
  await runCredits(["set", "50"], {
    json: true,
    stdout: io1.stdout,
    stderr: io1.stderr,
    homeDir: tmpHome,
    nowIso: () => "2026-11-09T12:00:00.000Z",
    nowMs: () => Date.parse("2026-11-09T12:00:00.000Z"),
  });

  const io2 = makeBuffers();
  await runCredits(["budget", "100"], {
    json: true,
    stdout: io2.stdout,
    stderr: io2.stderr,
    homeDir: tmpHome,
    nowIso: () => "2026-11-09T12:01:00.000Z",
    nowMs: () => Date.parse("2026-11-09T12:01:00.000Z"),
  });

  assert.equal(JSON.parse(io2.stdoutText).estimatedBalanceCu, 50);
  assert.equal(JSON.parse(io2.stdoutText).budgetCu, 100);

  const ledgerIo = makeBuffers();
  await runLedger(["--month", "2026-11"], {
    json: true,
    stdout: ledgerIo.stdout,
    stderr: ledgerIo.stderr,
    homeDir: tmpHome,
  });

  assert.deepEqual(JSON.parse(ledgerIo.stdoutText), {
    events: [
      {
        type: "calibrate",
        at: "2026-11-09T12:00:00.000Z",
        account: "default",
        balanceCu: 50,
        source: "manual",
      },
      {
        type: "budget.set",
        at: "2026-11-09T12:01:00.000Z",
        account: "default",
        budgetCu: 100,
      },
    ],
  });
});

test("projectAccountCredits preserves unended session.start intervals when a runtime is replaced and reconciles colab-api calibrations", () => {
  const events = [
    {
      type: "calibrate",
      at: "2026-11-09T10:00:00.000Z",
      account: "default",
      balanceCu: 2500,
      source: "colab-api",
    },
    {
      type: "session.start",
      at: "2026-11-10T03:00:00.000Z",
      account: "default",
      session: "orca-colab-decision-api",
      gpuName: "NVIDIA L4",
      rateKey: "L4",
      cuPerHour: 1.94,
    },
    {
      type: "session.start",
      at: "2026-11-10T09:00:00.000Z",
      account: "default",
      session: "orca-colab-decision-api",
      gpuName: "NVIDIA L4",
      rateKey: "L4",
      cuPerHour: 1.94,
    },
    {
      type: "session.start",
      at: "2026-11-10T09:00:30.000Z",
      account: "default",
      session: "orca-colab-decision-api",
      gpuName: "NVIDIA L4",
      rateKey: "L4",
      cuPerHour: 4.82,
    },
    {
      type: "calibrate",
      at: "2026-11-10T09:00:30.000Z",
      account: "default",
      balanceCu: 2495.5,
      consumptionRateHourly: 1.94,
      assignmentsCount: 1,
      source: "colab-api",
    },
  ];

  const activeSessions = [
    {
      name: "orca-colab-decision-api",
      account: "default",
      createdAt: "2026-11-10T09:00:30.000Z",
      cuPerHour: 4.82,
      state: "active",
    },
  ];

  const nowMs = Date.parse("2026-11-10T10:00:30.000Z");
  const projected = projectAccountCredits({
    events,
    activeSessions,
    account: "default",
    nowMs,
    month: "2026-11",
  });

  // Direct from colab-api: balance is paidComputeUnitsBalance (2495.5), monthly used is 2500 - 2495.5 = 4.5 CU
  assert.equal(projected.estimatedBurnCuPerHour, 1.94);
  assert.equal(projected.estimatedBalanceCu, 2495.5);
  assert.equal(projected.estimatedMonthlyUsedCu, 4.5);
  assert.equal(projected.sessionsThisMonth, 2);
});
