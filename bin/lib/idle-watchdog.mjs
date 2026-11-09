import { isProcessAlive } from "./task-store.mjs";

export const LOW_GPU_UTIL_THRESHOLD_PERCENT = 5;
export const REQUIRED_CONSECUTIVE_LOW_SAMPLES = 3;
export const DEFAULT_AUTO_STOP_IDLE_MINUTES = 20;
export const GRACE_PERIOD_MINUTES = 5;

export function evaluateSessionIdleState({
  session,
  gpuSamples = [],
  runningTasksCount = 0,
  autoStopIdleMinutes = DEFAULT_AUTO_STOP_IDLE_MINUTES,
  nowMs = Date.now(),
  checkPid = isProcessAlive,
}) {
  if (!session || session.state === "zombie") {
    return {
      isIdle: false,
      reason: "session-inactive",
      consecutiveLowSamples: 0,
      idleMinutes: 0,
    };
  }

  if (session.keep) {
    return {
      isIdle: false,
      reason: "keep-enabled",
      consecutiveLowSamples: 0,
      idleMinutes: 0,
    };
  }

  if (!autoStopIdleMinutes || autoStopIdleMinutes <= 0) {
    return {
      isIdle: false,
      reason: "watchdog-disabled",
      consecutiveLowSamples: 0,
      idleMinutes: 0,
    };
  }

  const activePids = Array.isArray(session.activePids) ? session.activePids : [];
  const hasLivePid = activePids.some((pid) => checkPid(pid));
  if (hasLivePid || runningTasksCount > 0) {
    return {
      isIdle: false,
      reason: "active-process",
      consecutiveLowSamples: 0,
      idleMinutes: 0,
    };
  }

  const lastActivityMs = Date.parse(session.lastActivityAt || session.createdAt);
  const idleMs = Number.isFinite(lastActivityMs)
    ? Math.max(0, nowMs - lastActivityMs)
    : 0;
  const idleMinutes = idleMs / 60_000;

  let consecutiveLowSamples = 0;
  for (let i = gpuSamples.length - 1; i >= 0; i -= 1) {
    const sample = Number(gpuSamples[i]);
    if (Number.isFinite(sample) && sample < LOW_GPU_UTIL_THRESHOLD_PERCENT) {
      consecutiveLowSamples += 1;
    } else {
      break;
    }
  }

  if (idleMinutes < autoStopIdleMinutes) {
    return {
      isIdle: false,
      reason: "recent-cli-activity",
      consecutiveLowSamples,
      idleMinutes: Number(idleMinutes.toFixed(2)),
    };
  }

  if (consecutiveLowSamples < REQUIRED_CONSECUTIVE_LOW_SAMPLES) {
    return {
      isIdle: false,
      reason: "insufficient-low-gpu-samples",
      consecutiveLowSamples,
      idleMinutes: Number(idleMinutes.toFixed(2)),
    };
  }

  return {
    isIdle: true,
    reason: "idle-threshold-met",
    consecutiveLowSamples,
    idleMinutes: Number(idleMinutes.toFixed(2)),
  };
}

export function evaluateBudgetAlert({
  projection,
  monthKey,
  alreadyNotified = {},
}) {
  if (
    !projection ||
    typeof projection.budgetCu !== "number" ||
    projection.budgetCu <= 0
  ) {
    return {
      tone: undefined,
      ratio: null,
      alertLevel: null,
      shouldNotify: false,
    };
  }

  const used = Number(projection.estimatedMonthlyUsedCu || 0);
  const ratio = used / projection.budgetCu;
  const keyPrefix = `${projection.account || "default"}:${monthKey}`;

  if (ratio >= 1.0) {
    const notifyKey = `${keyPrefix}:100`;
    return {
      tone: "danger",
      ratio: Number(ratio.toFixed(4)),
      alertLevel: "100%",
      notifyKey,
      shouldNotify: !alreadyNotified[notifyKey],
    };
  }

  if (ratio >= 0.8) {
    const notifyKey = `${keyPrefix}:80`;
    return {
      tone: "warning",
      ratio: Number(ratio.toFixed(4)),
      alertLevel: "80%",
      notifyKey,
      shouldNotify: !alreadyNotified[notifyKey],
    };
  }

  return {
    tone: undefined,
    ratio: Number(ratio.toFixed(4)),
    alertLevel: null,
    shouldNotify: false,
  };
}
