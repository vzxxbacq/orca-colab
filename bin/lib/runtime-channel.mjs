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

  async function send(url, init = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const session = current();
      const expiresMs = Date.parse(session.colabRuntime.tokenExpiry || "");
      if (attempt === 0 && Number.isFinite(expiresMs) && expiresMs - Date.now() < 120_000) {
        await refreshToken().catch((err) => {
          if (err instanceof SessionGoneError) throw err;
        });
      }
      const token = current().colabRuntime.token;
      let res;
      try {
        res = await fetchImpl(url, {
          ...init,
          headers: { ...COLAB_HEADERS, ...init.headers, [COLAB_PROXY_TOKEN_HEADER]: token },
        });
      } catch (err) {
        if (attempt >= 2) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
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
