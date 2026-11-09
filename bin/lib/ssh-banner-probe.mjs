import net from "node:net";
import {
  CliError,
  EXIT_ABORTED,
  EXIT_TIMEOUT,
} from "./cli-output.mjs";

export function probeSshBannerOnce({
  host,
  port = 22,
  timeoutMs = 3000,
  signal = null,
}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: "aborted" });
      return;
    }

    let settled = false;
    let buffer = "";
    const socket = net.createConnection({ host, port });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(result);
    };

    const onAbort = () => finish({ ok: false, reason: "aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.startsWith("SSH-")) {
        const firstLine = buffer.split(/\r?\n/)[0];
        finish({ ok: true, banner: firstLine });
      } else if (buffer.length >= 4) {
        finish({ ok: false, reason: "unexpected-banner" });
      }
    });

    socket.on("error", (err) => {
      finish({ ok: false, reason: err?.code || err?.message || "socket-error" });
    });

    socket.on("close", () => {
      finish({ ok: false, reason: "closed-before-banner" });
    });
  });
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForSshBanner({
  host,
  port = 22,
  deadlineMs,
  pollIntervalMs = 1500,
  attemptTimeoutMs = 3000,
  signal = null,
  now = () => Date.now(),
  sleep = defaultSleep,
  probeOnce = probeSshBannerOnce,
}) {
  while (true) {
    if (signal?.aborted) {
      throw new CliError(`aborted while probing SSH on ${host}:${port}`, {
        exitCode: EXIT_ABORTED,
        payload: {
          ok: false,
          error: `aborted while probing SSH on ${host}:${port}`,
          step: "ssh-banner",
        },
      });
    }

    const remainingBeforeAttempt = deadlineMs - now();
    if (remainingBeforeAttempt <= 0) {
      throw new CliError(`timed out waiting for SSH banner on ${host}:${port}`, {
        exitCode: EXIT_TIMEOUT,
        payload: {
          ok: false,
          error: `timed out waiting for SSH banner on ${host}:${port}`,
          step: "ssh-banner",
        },
      });
    }

    const res = await probeOnce({
      host,
      port,
      timeoutMs: Math.min(attemptTimeoutMs, Math.max(200, remainingBeforeAttempt)),
      signal,
    });

    if (res.ok) {
      return { host, port, banner: res.banner };
    }

    if (signal?.aborted || res.reason === "aborted") {
      throw new CliError(`aborted while probing SSH on ${host}:${port}`, {
        exitCode: EXIT_ABORTED,
        payload: {
          ok: false,
          error: `aborted while probing SSH on ${host}:${port}`,
          step: "ssh-banner",
        },
      });
    }

    const remaining = deadlineMs - now();
    if (remaining <= 0) {
      throw new CliError(`timed out waiting for SSH banner on ${host}:${port}`, {
        exitCode: EXIT_TIMEOUT,
        payload: {
          ok: false,
          error: `timed out waiting for SSH banner on ${host}:${port}`,
          step: "ssh-banner",
        },
      });
    }

    try {
      await sleep(Math.min(pollIntervalMs, remaining), signal);
    } catch {
      if (signal?.aborted) {
        throw new CliError(`aborted while probing SSH on ${host}:${port}`, {
          exitCode: EXIT_ABORTED,
          payload: {
            ok: false,
            error: `aborted while probing SSH on ${host}:${port}`,
            step: "ssh-banner",
          },
        });
      }
    }
  }
}

export async function waitForSshPortClosed({
  host,
  port = 22,
  timeoutMs = 30_000,
  pollIntervalMs = 1000,
  attemptTimeoutMs = 1500,
  signal = null,
  now = () => Date.now(),
  sleep = defaultSleep,
  probeOnce = probeSshBannerOnce,
}) {
  const deadlineMs = now() + timeoutMs;
  while (now() < deadlineMs) {
    if (signal?.aborted) {
      return false;
    }
    const res = await probeOnce({
      host,
      port,
      timeoutMs: attemptTimeoutMs,
      signal,
    });
    if (!res.ok) {
      return true;
    }
    const remaining = deadlineMs - now();
    if (remaining <= 0) {
      break;
    }
    try {
      await sleep(Math.min(pollIntervalMs, remaining), signal);
    } catch {
      return false;
    }
  }
  return false;
}
