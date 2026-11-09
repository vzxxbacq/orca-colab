import os from "node:os";
import { readSession, writeSession } from "./session-store.mjs";

export function stampSessionActivity(
  sessionName,
  homeDir = os.homedir(),
  {
    pid = process.pid,
    addPid = false,
    removePid = false,
    nowIso = () => new Date().toISOString(),
  } = {},
) {
  const current = readSession(sessionName, homeDir);
  if (!current) {
    return null;
  }
  const pidSet = new Set(current.activePids);
  if (addPid && Number.isInteger(pid)) {
    pidSet.add(pid);
  }
  if (removePid && Number.isInteger(pid)) {
    pidSet.delete(pid);
  }
  return writeSession(
    {
      ...current,
      lastActivityAt: nowIso(),
      activePids: [...pidSet],
    },
    homeDir,
  );
}

export async function withSessionActivity(
  sessionName,
  homeDir,
  fn,
  {
    pid = process.pid,
    nowIso = () => new Date().toISOString(),
    intervalMs = 60_000,
  } = {},
) {
  stampSessionActivity(sessionName, homeDir, {
    pid,
    addPid: true,
    nowIso,
  });

  const timer = setInterval(() => {
    stampSessionActivity(sessionName, homeDir, {
      pid,
      addPid: true,
      nowIso,
    });
  }, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  try {
    return await fn();
  } finally {
    clearInterval(timer);
    stampSessionActivity(sessionName, homeDir, {
      pid,
      removePid: true,
      nowIso,
    });
  }
}
