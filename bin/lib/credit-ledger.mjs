import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import os from "node:os";
import { ensureColabHome, getColabPaths } from "./colab-home.mjs";

const MS_PER_HOUR = 3_600_000;
const REATTACH_WINDOW_MS = 90 * 60_000;
const ORPHAN_SESSION_CAP_MS = 60 * 60_000;

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function resolveDeadSessionEndIso(session, nowMs = Date.now()) {
  const startMs = Date.parse(session?.createdAt || "");
  const lastActMs = Date.parse(session?.lastActivityAt || "");
  const expiryMs = Date.parse(session?.colabRuntime?.tokenExpiry || "");
  if (Number.isFinite(expiryMs)) {
    const latestAliveMs = Math.max(
      Number.isFinite(startMs) ? startMs : 0,
      Number.isFinite(lastActMs) ? lastActMs : 0,
      expiryMs,
    );
    return new Date(Math.min(nowMs, latestAliveMs)).toISOString();
  }
  if (Number.isFinite(startMs) && nowMs - startMs > REATTACH_WINDOW_MS) {
    const latestKnownMs = Math.max(
      startMs,
      Number.isFinite(lastActMs) ? lastActMs : startMs,
    );
    return new Date(
      Math.min(nowMs, latestKnownMs + ORPHAN_SESSION_CAP_MS),
    ).toISOString();
  }
  return new Date(nowMs).toISOString();
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
    consumptionRateHourly = null,
    assignmentsCount = null,
    source = "manual",
    at = new Date().toISOString(),
  },
  homeDir = os.homedir(),
) {
  const event = {
    type: "calibrate",
    at,
    account,
    balanceCu: Number(balanceCu),
    source,
  };
  if (
    typeof consumptionRateHourly === "number" &&
    Number.isFinite(consumptionRateHourly)
  ) {
    event.consumptionRateHourly = round2(consumptionRateHourly);
  }
  if (
    typeof assignmentsCount === "number" &&
    Number.isFinite(assignmentsCount)
  ) {
    event.assignmentsCount = Math.max(0, Math.floor(assignmentsCount));
  }
  return appendLedgerEvent(event, homeDir);
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

  const openStarts = new Map();
  const endedIntervals = [];
  const calibrationsInMonth = [];
  let lastCalibration = null;
  let latestBudget = null;

  for (const ev of accountEvents) {
    if (ev.type === "calibrate") {
      lastCalibration = ev;
      if (typeof ev.at === "string" && ev.at.slice(0, 7) === targetMonth) {
        calibrationsInMonth.push(ev);
      }
      continue;
    }
    if (ev.type === "budget.set") {
      latestBudget = ev;
      continue;
    }
    if (ev.type === "session.start" && ev.session) {
      const startMs = Date.parse(ev.at);
      const cuPerHour = Number(ev.cuPerHour ?? 0);
      if (Number.isNaN(startMs) || !Number.isFinite(cuPerHour)) {
        continue;
      }
      const prev = openStarts.get(ev.session);
      if (prev) {
        if (
          startMs >= prev.lastSeenMs &&
          startMs - prev.lastSeenMs <= REATTACH_WINDOW_MS
        ) {
          openStarts.set(ev.session, {
            ...prev,
            lastSeenMs: startMs,
            cuPerHour: cuPerHour || prev.cuPerHour,
          });
        } else if (startMs > prev.startMs) {
          const orphanEndMs = Math.min(
            startMs,
            prev.lastSeenMs + ORPHAN_SESSION_CAP_MS,
          );
          endedIntervals.push({
            session: ev.session,
            startMs: prev.startMs,
            endMs: orphanEndMs,
            startIso: prev.startIso,
            endIso: new Date(orphanEndMs).toISOString(),
            cuPerHour: prev.cuPerHour,
            cause: "colab-died",
          });
          openStarts.set(ev.session, {
            session: ev.session,
            startMs,
            startIso: ev.at,
            lastSeenMs: startMs,
            cuPerHour,
          });
        }
      } else {
        openStarts.set(ev.session, {
          session: ev.session,
          startMs,
          startIso: ev.at,
          lastSeenMs: startMs,
          cuPerHour,
        });
      }
      continue;
    }
    if (ev.type === "session.end") {
      const matchedStart = ev.session ? openStarts.get(ev.session) : null;
      if (ev.session) {
        openStarts.delete(ev.session);
      }
      const rawStartIso = ev.startedAt ?? matchedStart?.startIso ?? ev.at;
      const rawStartMs = Date.parse(rawStartIso);
      const useMatchedStart =
        matchedStart &&
        (!Number.isFinite(rawStartMs) ||
          (rawStartMs >= matchedStart.startMs &&
            rawStartMs - matchedStart.startMs <= REATTACH_WINDOW_MS));
      const startIso = useMatchedStart ? matchedStart.startIso : rawStartIso;
      const startMs = useMatchedStart ? matchedStart.startMs : rawStartMs;
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
  }

  const accountActiveSessions = activeSessions.filter(
    (s) => (s?.account ?? "default") === account && s?.state !== "zombie",
  );

  const activeIntervals = [];
  for (const s of accountActiveSessions) {
    const rawStartMs = Date.parse(s.createdAt);
    const matchedStart = s.name ? openStarts.get(s.name) : null;
    if (s.name) {
      openStarts.delete(s.name);
    }
    let startMs = rawStartMs;
    let startIso = s.createdAt;
    if (matchedStart && !Number.isNaN(rawStartMs)) {
      if (
        rawStartMs >= matchedStart.startMs &&
        rawStartMs - matchedStart.lastSeenMs <= REATTACH_WINDOW_MS
      ) {
        startMs = matchedStart.startMs;
        startIso = matchedStart.startIso;
      } else if (rawStartMs > matchedStart.startMs) {
        const orphanEndMs = Math.min(
          rawStartMs,
          matchedStart.lastSeenMs + ORPHAN_SESSION_CAP_MS,
        );
        endedIntervals.push({
          session: s.name,
          startMs: matchedStart.startMs,
          endMs: orphanEndMs,
          startIso: matchedStart.startIso,
          endIso: new Date(orphanEndMs).toISOString(),
          cuPerHour: matchedStart.cuPerHour,
          cause: "colab-died",
        });
      }
    }
    const cuPerHour = Number(s.cuPerHour ?? matchedStart?.cuPerHour ?? 0);
    if (!Number.isNaN(startMs) && nowMs >= startMs && Number.isFinite(cuPerHour)) {
      activeIntervals.push({
        session: s.name,
        startMs,
        endMs: nowMs,
        startIso,
        endIso: new Date(nowMs).toISOString(),
        cuPerHour,
        cause: null,
      });
    }
  }

  for (const orphan of openStarts.values()) {
    if (nowMs > orphan.startMs) {
      const orphanEndMs = Math.min(
        nowMs,
        orphan.lastSeenMs + ORPHAN_SESSION_CAP_MS,
      );
      endedIntervals.push({
        session: orphan.session,
        startMs: orphan.startMs,
        endMs: orphanEndMs,
        startIso: orphan.startIso,
        endIso: new Date(orphanEndMs).toISOString(),
        cuPerHour: orphan.cuPerHour,
        cause: "colab-died",
      });
    }
  }

  const allIntervals = [...endedIntervals, ...activeIntervals];

  const isColabApiCalibrated = lastCalibration?.source === "colab-api";

  let estimatedBurnCuPerHour = round2(
    accountActiveSessions.reduce((sum, s) => sum + Number(s.cuPerHour ?? 0), 0),
  );
  if (
    isColabApiCalibrated &&
    typeof lastCalibration.consumptionRateHourly === "number" &&
    Number.isFinite(lastCalibration.consumptionRateHourly)
  ) {
    if (
      accountActiveSessions.length === 0 ||
      lastCalibration.assignmentsCount === 0
    ) {
      estimatedBurnCuPerHour = 0;
    } else if (lastCalibration.consumptionRateHourly > 0) {
      estimatedBurnCuPerHour = round2(lastCalibration.consumptionRateHourly);
    }
  }

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

    if (isColabApiCalibrated) {
      estimatedBalanceCu = round2(Math.max(0, lastCalibratedBalanceCu));
    } else {
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
  }

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

  const apiCals = calibrationsInMonth.filter(
    (c) =>
      c.source === "colab-api" &&
      Number.isFinite(Number(c.balanceCu)) &&
      !Number.isNaN(Date.parse(c.at)),
  );
  if (apiCals.length >= 1) {
    let calibratedSpanUsed = 0;
    for (let i = 0; i < apiCals.length - 1; i++) {
      const prevBal = Number(apiCals[i].balanceCu);
      const nextBal = Number(apiCals[i + 1].balanceCu);
      if (nextBal < prevBal) {
        calibratedSpanUsed += prevBal - nextBal;
      }
    }
    monthlyUsed = calibratedSpanUsed;
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
