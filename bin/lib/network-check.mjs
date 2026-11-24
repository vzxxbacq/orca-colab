import os from "node:os";
import { COLAB_OAUTH_CONFIG, resolveOAuthClientConfig } from "./colab-oauth.mjs";
import { describeNetworkFailure, describeProxyPlan, proxyRouteFor } from "./network-proxy.mjs";
import { listSessions } from "./session-store.mjs";

// Every host orca-colab talks to. Any HTTP answer counts as reachable: these requests carry no
// credentials, so Google answering 400 or 401 is the expected outcome.
function endpoints(homeDir) {
  const client = resolveOAuthClientConfig(homeDir);
  const list = [];
  if (client.relayUrl) {
    list.push({ name: "token-relay", purpose: "sign-in and token refresh", url: client.relayUrl });
  }
  list.push(
    { name: "google-token", purpose: "Google OAuth tokens", url: COLAB_OAUTH_CONFIG.tokenEndpoint },
    { name: "google-userinfo", purpose: "account e-mail", url: COLAB_OAUTH_CONFIG.userInfoEndpoint },
    { name: "colab-api", purpose: "runtimes", url: COLAB_OAUTH_CONFIG.colabPublicApiDomain },
    { name: "colab-web", purpose: "compute-unit balance", url: COLAB_OAUTH_CONFIG.colabApiDomain },
  );
  for (const session of listSessions(homeDir)) {
    if (session.state !== "zombie" && session.colabRuntime?.baseUrl) {
      list.push({ name: `runtime:${session.name}`, purpose: "commands, files and terminals on the runtime", url: session.colabRuntime.baseUrl });
    }
  }
  return list;
}

export async function checkNetwork({ homeDir = os.homedir(), fetchImpl = fetch, timeoutMs = 10_000, targets = endpoints(homeDir) } = {}) {
  const results = await Promise.all(
    targets.map(async ({ name, purpose, url }) => {
      const route = proxyRouteFor(url);
      const base = { name, purpose, host: new URL(url).host, proxy: route?.proxy ?? null, proxySource: route?.source ?? null };
      const started = performance.now();
      try {
        const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        await res.arrayBuffer().catch(() => {});
        return { ...base, ok: true, status: res.status, latencyMs: Math.round(performance.now() - started), causeCode: null, error: null };
      } catch (err) {
        const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
        const failure = err?.code === "NETWORK_UNREACHABLE" ? err : describeNetworkFailure(err, url);
        return {
          ...base,
          ok: false,
          status: null,
          latencyMs: Math.round(performance.now() - started),
          causeCode: timedOut ? "ETIMEDOUT" : failure?.causeCode ?? err?.cause?.code ?? err?.code ?? "ERROR",
          error: timedOut
            ? `no answer within ${Math.round(timeoutMs / 1000)}s${route ? ` through the proxy ${route.proxy}` : ""}`
            : failure?.cause?.message ?? err?.message ?? String(err),
        };
      }
    }),
  );
  const failed = results.filter((r) => !r.ok);
  const proxy = describeProxyPlan();
  return {
    ok: failed.length === 0,
    proxy,
    endpoints: results,
    action:
      failed.length === 0
        ? null
        : proxy.url
          ? `${failed.map((r) => r.host).join(", ")} not reachable through the proxy ${proxy.url} (${proxy.source}). Check that the proxy is running and allows these hosts, or change it: panel Setup → Network proxy, --proxy <url|off>, ORCA_COLAB_PROXY.`
          : `${failed.map((r) => r.host).join(", ")} not reachable and no proxy is in use. If this computer needs a proxy to reach Google, set it: panel Setup → Network proxy, --proxy <url>, ORCA_COLAB_PROXY or HTTPS_PROXY.`,
  };
}
