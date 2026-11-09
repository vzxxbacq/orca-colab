import {
  CliError,
  EXIT_ABORTED,
  EXIT_TIMEOUT,
} from "./cli-output.mjs";

const COLAB_HOST_PREFIX = "orca-colab-";

function peerIdentityKey(peer) {
  return `${peer.id ?? ""}:${peer.ipv4 ?? ""}:${peer.hostName ?? ""}`;
}

export function isColabPeerHostName(hostName, expectedName = null) {
  if (typeof hostName !== "string" || !hostName) {
    return false;
  }
  const lower = hostName.toLowerCase();
  if (expectedName) {
    const target = expectedName.toLowerCase();
    const prefixed = target.startsWith(COLAB_HOST_PREFIX)
      ? target
      : `${COLAB_HOST_PREFIX}${target}`;
    return lower === target || lower === prefixed;
  }
  return lower.startsWith(COLAB_HOST_PREFIX);
}

export function snapshotOnlinePeers(peers = []) {
  const set = new Set();
  for (const peer of peers) {
    if (peer?.online && isColabPeerHostName(peer.hostName)) {
      set.add(peerIdentityKey(peer));
    }
  }
  return set;
}

export function findNewColabPeer(
  peers = [],
  baselineSet = new Set(),
  expectedName = null,
) {
  for (const peer of peers) {
    if (!peer?.online || !peer?.ipv4) {
      continue;
    }
    if (!isColabPeerHostName(peer.hostName, expectedName)) {
      continue;
    }
    if (baselineSet.has(peerIdentityKey(peer))) {
      continue;
    }
    return peer;
  }
  return null;
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

export async function waitForColabPeer({
  fetchStatus,
  baselinePeers = null,
  expectedName = null,
  pollIntervalMs = 3000,
  deadlineMs,
  signal = null,
  now = () => Date.now(),
  sleep = defaultSleep,
}) {
  const baselineSet =
    baselinePeers instanceof Set
      ? baselinePeers
      : snapshotOnlinePeers(baselinePeers ?? []);

  while (true) {
    if (signal?.aborted) {
      throw new CliError("aborted while waiting for Tailscale peer", {
        exitCode: EXIT_ABORTED,
        payload: {
          ok: false,
          error: "aborted while waiting for Tailscale peer",
          step: "tailscale-peer",
        },
      });
    }

    const status = await fetchStatus();
    const match = findNewColabPeer(status?.peers ?? [], baselineSet, expectedName);
    if (match) {
      return match;
    }

    const remaining = deadlineMs - now();
    if (remaining <= 0) {
      throw new CliError(
        "timed out waiting for a new online orca-colab-* Tailscale peer",
        {
          exitCode: EXIT_TIMEOUT,
          payload: {
            ok: false,
            error:
              "timed out waiting for a new online orca-colab-* Tailscale peer",
            step: "tailscale-peer",
          },
        },
      );
    }

    try {
      await sleep(Math.min(pollIntervalMs, remaining), signal);
    } catch {
      if (signal?.aborted) {
        throw new CliError("aborted while waiting for Tailscale peer", {
          exitCode: EXIT_ABORTED,
          payload: {
            ok: false,
            error: "aborted while waiting for Tailscale peer",
            step: "tailscale-peer",
          },
        });
      }
    }
  }
}
