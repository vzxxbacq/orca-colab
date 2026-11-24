import os from "node:os";
import { createRuntimeChannel } from "./runtime-channel.mjs";
import { describeOrigin, stampRuntimeActivity } from "./runtime-records.mjs";
import { readSession, writeSession } from "./session-store.mjs";

// The same stamp on the runtime, where the idle watchdog of every machine reads it. Best effort and
// bounded: a command never fails or waits long because of it.
async function stampOnRuntime(sessionName, homeDir, { running, origin, command, fetchImpl }) {
  try {
    const channel = createRuntimeChannel({ sessionName, homeDir, fetchImpl });
    await Promise.race([
      stampRuntimeActivity(channel, { origin, command, running }),
      new Promise((resolve) => setTimeout(resolve, 4000).unref?.()),
    ]);
  } catch {
    // No runtime proxy, offline, or the runtime is gone.
  }
}

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
    env = process.env,
    command = null,
    fetchImpl = fetch,
    stampRuntime = stampOnRuntime,
  } = {},
) {
  stampSessionActivity(sessionName, homeDir, {
    pid,
    addPid: true,
    nowIso,
  });
  const remote = { origin: describeOrigin({ env: env || process.env }), command, fetchImpl };
  let remoteStamp = stampRuntime ? stampRuntime(sessionName, homeDir, { ...remote, running: true }) : null;

  const timer = setInterval(() => {
    stampSessionActivity(sessionName, homeDir, {
      pid,
      addPid: true,
      nowIso,
    });
    if (stampRuntime) {
      remoteStamp = stampRuntime(sessionName, homeDir, { ...remote, running: true });
    }
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
    if (stampRuntime) {
      await remoteStamp;
      await stampRuntime(sessionName, homeDir, { ...remote, running: false });
    }
  }
}
