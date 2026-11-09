import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import os from "node:os";
import { ensureColabHome, getColabPaths } from "./colab-home.mjs";

const MS_PER_HOUR = 3_600_000;

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function appendLedgerEvent(event, homeDir = os.homedir()) {
  const { ledgerPath } = ensureColabHome(homeDir);
  const line = `${JSON.stringify(event)}\n`;
  appendFileSync(ledgerPath, line, { encoding: "utf8", mode: 0o600 });
  chmodSync(ledgerPath, 0o600);
  return event;
}

export function readLedgerEvents(homeDir = os.homedir()) {
  const { ledgerPath } = getColabPaths(homeDir);
  let raw;
  try {
    raw = readFileSync(ledgerPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore malformed lines if an external editor corrupted a line.
    }
  }
  return events;
}

export function recordSessionStartEvent(session, homeDir = os.homedir()) {
  return appendLedgerEvent(
    {
      type: "session.start",
      at: session.createdAt,
      account: session.account ?? "default",
      session: session.name,
      gpuName: session.gpu?.name ?? "CPU",
      rateKey: session.rateKey,
      cuPerHour: session.cuPerHour,
    },
    homeDir,
  );
}

export function recordSessionEndEvent(
  session,
  { cause = "user", endedAt = new Date().toISOString(), homeDir = os.homedir() } = {},
) {
  return appendLedgerEvent(
    {
      type: "session.end",
      at: endedAt,
      startedAt: session.createdAt,
      account: session.account ?? "default",
      session: session.name,
      rateKey: session.rateKey,
      cuPerHour: session.cuPerHour,
      cause,
    },
    homeDir,
  );
}

export function recordCalibrateEvent(
  {
    account = "default",
    balanceCu,
    source = "manual",
    at = new Date().toISOString(),
  },
  homeDir = os.homedir(),
) {
  return appendLedgerEvent(
    {
      type: "calibrate",
      at,
      account,
      balanceCu: Number(balanceCu),
      source,
    },
    homeDir,
  );
}

export function recordBudgetSetEvent(
  { account = "default", budgetCu, at = new Date().toISOString() },
  homeDir = os.homedir(),
) {
  return appendLedgerEvent(
    {
      type: "budget.set",
      at,
      account,
      budgetCu: Number(budgetCu),
    },
    homeDir,
  );
}

export function projectAccountCredits({
  events = [],
  activeSessions = [],
  account = "default",
  nowMs = Date.now(),
  month = null,
}) {
  const targetMonth = month ?? new Date(nowMs).toISOString().slice(0, 7);
  const accountEvents = events.filter(
    (e) => (e?.account ?? "default") === account,
  );

  const startMap = new Map();
  let lastCalibration = null;
  let latestBudget = null;

  for (const ev of accountEvents) {
    if (ev.type === "session.start" && ev.session) {
      startMap.set(ev.session, ev);
    } else if (ev.type === "calibrate") {
      lastCalibration = ev;
    } else if (ev.type === "budget.set") {
      latestBudget = ev;
    }
  }

  const endedIntervals = [];
  for (const ev of accountEvents) {
    if (ev.type !== "session.end") continue;
    const matchedStart = ev.session ? startMap.get(ev.session) : null;
    const startIso = ev.startedAt ?? matchedStart?.at ?? ev.at;
    const startMs = Date.parse(startIso);
    const endMs = Date.parse(ev.at);
    const cuPerHour = Number(
      ev.cuPerHour ?? matchedStart?.cuPerHour ?? 0,
    );
    if (
      !Number.isNaN(startMs) &&
      !Number.isNaN(endMs) &&
      endMs >= startMs &&
      Number.isFinite(cuPerHour)
    ) {
      endedIntervals.push({
        session: ev.session ?? null,
        startMs,
        endMs,
        startIso,
        endIso: ev.at,
        cuPerHour,
        cause: ev.cause ?? "user",
      });
    }
  }

  const accountActiveSessions = activeSessions.filter(
    (s) => (s?.account ?? "default") === account && s?.state !== "zombie",
  );

  const activeIntervals = [];
  for (const s of accountActiveSessions) {
    const startMs = Date.parse(s.createdAt);
    const cuPerHour = Number(s.cuPerHour ?? 0);
    if (!Number.isNaN(startMs) && nowMs >= startMs && Number.isFinite(cuPerHour)) {
      activeIntervals.push({
        session: s.name,
        startMs,
        endMs: nowMs,
        startIso: s.createdAt,
        endIso: new Date(nowMs).toISOString(),
        cuPerHour,
        cause: null,
      });
    }
  }

  const allIntervals = [...endedIntervals, ...activeIntervals];

  let estimatedBalanceCu = null;
  let calibrationAgeSeconds = null;
  let lastCalibratedAt = null;
  let lastCalibratedBalanceCu = null;

  if (lastCalibration && Number.isFinite(Number(lastCalibration.balanceCu))) {
    lastCalibratedAt = lastCalibration.at;
    lastCalibratedBalanceCu = Number(lastCalibration.balanceCu);
    const calMs = Date.parse(lastCalibration.at);
    calibrationAgeSeconds = Number.isNaN(calMs)
      ? null
      : Math.max(0, Math.floor((nowMs - calMs) / 1000));

    let burnedSinceCalibration = 0;
    if (!Number.isNaN(calMs)) {
      for (const interval of allIntervals) {
        const billStart = Math.max(interval.startMs, calMs);
        if (interval.endMs > billStart) {
          const hours = (interval.endMs - billStart) / MS_PER_HOUR;
          burnedSinceCalibration += hours * interval.cuPerHour;
        }
      }
    }
    estimatedBalanceCu = round2(
      Math.max(0, lastCalibratedBalanceCu - burnedSinceCalibration),
    );
  }

  const estimatedBurnCuPerHour = round2(
    accountActiveSessions.reduce((sum, s) => sum + Number(s.cuPerHour ?? 0), 0),
  );

  const estimatedHoursRemaining =
    estimatedBalanceCu !== null && estimatedBurnCuPerHour > 0
      ? round2(estimatedBalanceCu / estimatedBurnCuPerHour)
      : null;

  let monthlyUsed = 0;
  let wastedIdle = 0;
  let sessionsThisMonth = 0;

  for (const interval of allIntervals) {
    const startMonth = interval.startIso.slice(0, 7);
    const endMonth = interval.endIso.slice(0, 7);
    if (startMonth !== targetMonth && endMonth !== targetMonth) {
      continue;
    }
    sessionsThisMonth += 1;
    const hours = (interval.endMs - interval.startMs) / MS_PER_HOUR;
    const cost = hours * interval.cuPerHour;
    monthlyUsed += cost;
    if (interval.cause === "idle-watchdog") {
      wastedIdle += cost;
    }
  }

  const estimatedMonthlyUsedCu = round2(monthlyUsed);
  const estimatedWastedIdleCu = round2(wastedIdle);
  const budgetCu =
    latestBudget && Number.isFinite(Number(latestBudget.budgetCu))
      ? Number(latestBudget.budgetCu)
      : null;
  const estimatedBudgetUsedPercent =
    budgetCu !== null && budgetCu > 0
      ? round2((estimatedMonthlyUsedCu / budgetCu) * 100)
      : null;

  return {
    account,
    approximate: true,
    estimatedBalanceCu,
    lastCalibratedAt,
    lastCalibratedBalanceCu,
    calibrationAgeSeconds,
    estimatedBurnCuPerHour,
    estimatedHoursRemaining,
    budgetCu,
    estimatedMonthlyUsedCu,
    estimatedBudgetUsedPercent,
    sessionsThisMonth,
    estimatedWastedIdleCu,
  };
}
