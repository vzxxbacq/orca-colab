import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateBudgetAlert,
  evaluateSessionIdleState,
} from "../bin/lib/idle-watchdog.mjs";
import activateWorker, { deactivate as deactivateWorker } from "../worker/main.mjs";

test("worker/main.mjs activates and registers commands and panel handlers cleanly", async () => {
  const registeredCommands = new Map();
  const registeredPanels = new Map();
  let statusBarState = null;

  const fakeOrca = {
    host: {
      async has() { return true; },
      async call(method, params) {
        if (method === "statusBar.update") {
          statusBarState = params;
        }
        return {};
      },
    },
    commands: {
      register(id, fn) {
        registeredCommands.set(id, fn);
      },
    },
    panels: {
      handle(name, fn) {
        registeredPanels.set(name, fn);
      },
      post() {},
    },
    settings: {
      async get() { return undefined; },
    },
    log() {},
  };

  await activateWorker(fakeOrca);
  try {
    assert.equal(registeredCommands.has("colab.up"), true);
    assert.equal(registeredCommands.has("colab.down"), true);
    assert.equal(registeredCommands.has("colab.showPanel"), true);
    assert.equal(registeredPanels.has("colab.dashboard"), true);
    assert.equal(registeredPanels.has("colab.setupConfig"), true);
    assert.equal(registeredPanels.has("colab.submitTask"), true);
    assert.equal(registeredPanels.has("colab.getTaskLogs"), true);
    assert.equal(statusBarState?.id, "colab-sessions");
  } finally {
    deactivateWorker();
  }
});

test("idle watchdog D14: 40-minute run with one low sample or active PIDs does not trigger", () => {
  const baseNow = Date.parse("2026-11-09T12:40:00.000Z");
  const session40mAgo = {
    name: "orca-colab-t4",
    state: "active",
    keep: false,
    createdAt: "2026-11-09T12:00:00.000Z",
    lastActivityAt: "2026-11-09T12:00:00.000Z",
    activePids: [],
  };

  // Case 1: 40-minute run with one low sample (or non-consecutive low samples)
  const oneLow = evaluateSessionIdleState({
    session: session40mAgo,
    gpuSamples: [72, 68, 2, 85, 3],
    runningTasksCount: 0,
    autoStopIdleMinutes: 20,
    nowMs: baseNow,
  });
  assert.deepEqual(oneLow, {
    isIdle: false,
    reason: "insufficient-low-gpu-samples",
    consecutiveLowSamples: 1,
    idleMinutes: 40,
  });

  // Case 2: 3 consecutive low samples, but a running task or live PID is active
  const withRunningTask = evaluateSessionIdleState({
    session: session40mAgo,
    gpuSamples: [1, 0, 2],
    runningTasksCount: 1,
    autoStopIdleMinutes: 20,
    nowMs: baseNow,
  });
  assert.deepEqual(withRunningTask, {
    isIdle: false,
    reason: "active-process",
    consecutiveLowSamples: 0,
    idleMinutes: 0,
  });

  // Case 3: 3 consecutive low samples, but session has keep=true
  const kept = evaluateSessionIdleState({
    session: { ...session40mAgo, keep: true },
    gpuSamples: [0, 0, 0],
    runningTasksCount: 0,
    autoStopIdleMinutes: 20,
    nowMs: baseNow,
  });
  assert.deepEqual(kept, {
    isIdle: false,
    reason: "keep-enabled",
    consecutiveLowSamples: 0,
    idleMinutes: 0,
  });

  // Case 4: Both conditions met (no activity for >=20m AND 3 consecutive <5% samples)
  const trulyIdle = evaluateSessionIdleState({
    session: session40mAgo,
    gpuSamples: [45, 2, 1, 0],
    runningTasksCount: 0,
    autoStopIdleMinutes: 20,
    nowMs: baseNow,
  });
  assert.deepEqual(trulyIdle, {
    isIdle: true,
    reason: "idle-threshold-met",
    consecutiveLowSamples: 3,
    idleMinutes: 40,
  });
});

test("budget alert evaluates 80% warning and 100% danger once per threshold per month", () => {
  const notified = {};

  const warn1 = evaluateBudgetAlert({
    projection: {
      account: "default",
      budgetCu: 100,
      estimatedMonthlyUsedCu: 82,
    },
    monthKey: "2026-11",
    alreadyNotified: notified,
  });
  assert.deepEqual(warn1, {
    tone: "warning",
    ratio: 0.82,
    alertLevel: "80%",
    notifyKey: "default:2026-11:80",
    shouldNotify: true,
  });

  notified[warn1.notifyKey] = true;
  const warn2 = evaluateBudgetAlert({
    projection: {
      account: "default",
      budgetCu: 100,
      estimatedMonthlyUsedCu: 85,
    },
    monthKey: "2026-11",
    alreadyNotified: notified,
  });
  assert.equal(warn2.tone, "warning");
  assert.equal(warn2.shouldNotify, false);

  const danger1 = evaluateBudgetAlert({
    projection: {
      account: "default",
      budgetCu: 100,
      estimatedMonthlyUsedCu: 105,
    },
    monthKey: "2026-11",
    alreadyNotified: notified,
  });
  assert.deepEqual(danger1, {
    tone: "danger",
    ratio: 1.05,
    alertLevel: "100%",
    notifyKey: "default:2026-11:100",
    shouldNotify: true,
  });
});
