import os from "node:os";
import { COLAB_HEADERS, COLAB_PROXY_TOKEN_HEADER, getRuntime } from "./colab-api-client.mjs";
import { getValidAccessToken } from "./colab-oauth.mjs";
import { readSession, writeSession } from "./session-store.mjs";

export class SessionGoneError extends Error {
  constructor(sessionName, detail, { runtimeGone = false } = {}) {
    super(
      `Colab session '${sessionName}' is gone${detail ? ` (${detail})` : ""}. Start it again with 'orca-colab up', start the service on it, and restart 'orca-colab forward'.`,
    );
    this.code = "SESSION_GONE";
    // True only when Colab itself said the runtime no longer exists.
    this.runtimeGone = runtimeGone;
  }
}

// Names the request, never the host or a token: the message ends up in task logs and tool results.
function requestError(url, method = "GET", { err, timedOut, timeoutMs, attempts }) {
  const what = `${method} ${decodeURIComponent(new URL(url).pathname)}`;
  const tries = attempts > 1 ? ` (${attempts} attempts)` : "";
  const message = timedOut
    ? `${what} got no answer from the runtime within ${Math.round(timeoutMs / 1000)}s${tries}`
    : `${what} did not reach the runtime${tries}: ${err?.cause?.message || err?.message || err}`;
  return Object.assign(new Error(message, { cause: err }), { timedOut });
}

// Authenticated requests to the runtime's Jupyter server. The proxy token lives about an hour, so each
// call reads the session file (the panel refreshes it) and refreshes the token itself when refused.
export function createRuntimeChannel({ sessionName, homeDir = os.homedir(), fetchImpl = fetch }) {
  let refreshing = null;

  function current() {
    const session = readSession(sessionName, homeDir);
    if (!session?.colabRuntime?.baseUrl || !session.colabRuntime.token || session.state === "zombie") {
      throw new SessionGoneError(sessionName, session ? "it has no reachable runtime" : "no such session on this machine");
    }
    return session;
  }

  async function refreshToken() {
    refreshing ??= (async () => {
      const session = current();
      const accessToken = await getValidAccessToken({ account: session.account || "default", homeDir, fetchImpl });
      if (!accessToken) {
        throw new SessionGoneError(sessionName, "the Google sign-in is gone; run 'orca-colab auth login'");
      }
      let runtime;
      try {
        runtime = await getRuntime({ runtimeId: session.colabRuntime.id, accessToken, fetchImpl });
      } catch (err) {
        if (err?.status === 404) {
          throw new SessionGoneError(sessionName, "Colab no longer has this runtime", { runtimeGone: true });
        }
        throw err;
      }
      if (!runtime?.connectionInfo?.token) {
        throw new SessionGoneError(sessionName, "Colab no longer has this runtime", { runtimeGone: true });
      }
      writeSession(
        {
          ...current(),
          colabRuntime: {
            ...session.colabRuntime,
            token: runtime.connectionInfo.token,
            tokenExpiry: runtime.connectionInfo.expireTime || session.colabRuntime.tokenExpiry,
          },
        },
        homeDir,
      );
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  // `timeoutMs` bounds each attempt with a signal of its own: one signal for the whole call would leave
  // the attempts after a timeout already aborted. A request that timed out is sent again only when the
  // caller asks (`retryTimeouts`), because a reader would rather skip a stalled runtime than wait.
  async function send(url, { timeoutMs = null, retryTimeouts = false, ...init } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const session = current();
      const expiresMs = Date.parse(session.colabRuntime.tokenExpiry || "");
      if (attempt === 0 && Number.isFinite(expiresMs) && expiresMs - Date.now() < 120_000) {
        await refreshToken().catch((err) => {
          if (err instanceof SessionGoneError) throw err;
        });
      }
      const token = current().colabRuntime.token;
      const limit = timeoutMs && !init.signal ? AbortSignal.timeout(timeoutMs) : null;
      let res;
      try {
        res = await fetchImpl(url, {
          ...init,
          ...(limit ? { signal: limit } : {}),
          headers: { ...COLAB_HEADERS, ...init.headers, [COLAB_PROXY_TOKEN_HEADER]: token },
        });
      } catch (err) {
        const timedOut = Boolean(limit) && (limit.aborted || err?.name === "TimeoutError");
        const last = attempt >= 2 || init.signal?.aborted || (timedOut && !retryTimeouts);
        if (!last) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        if (init.signal?.aborted) throw err;
        throw requestError(url, init.method, { err, timedOut, timeoutMs, attempts: attempt + 1 });
      }
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        await res.arrayBuffer().catch(() => {});
        await refreshToken();
        continue;
      }
      return res;
    }
  }

  return {
    session: current,
    baseUrl: () => current().colabRuntime.baseUrl,
    fetch: send,
    refreshToken,
  };
}
