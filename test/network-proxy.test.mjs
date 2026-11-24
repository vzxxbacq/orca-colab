import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runLoopbackOAuthFlow } from "../bin/lib/colab-oauth.mjs";
import { writeConfig } from "../bin/lib/colab-home.mjs";
import { runDoctor } from "../bin/lib/doctor.mjs";
import {
  installNetworkProxy,
  parseMacSystemProxy,
  parseProxySetting,
  parseWindowsSystemProxy,
  proxyForUrl,
  resolveProxyPlan,
} from "../bin/lib/network-proxy.mjs";
import { createPanelActions } from "../bin/lib/panel-actions.mjs";
import { openRuntimeShell } from "../bin/lib/runtime-shell.mjs";
import {
  startConnectProxy,
  startOriginServer,
  startSocksProxy,
  TEST_ONLY_CERT,
  TEST_ONLY_KEY,
} from "./local-connect-proxy.mjs";

const CLI = fileURLToPath(new URL("../bin/orca-colab.mjs", import.meta.url));

function tempHome(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "orca-colab-proxy-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

const jsonOrigin = (body) => (req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ...body, path: req.url }));
};

test("the proxy comes from the override, then the panel setting, then the environment, then the system", (t) => {
  const home = tempHome(t);
  const system = { https: "http://10.0.0.1:8080", http: null, socks: null, bypass: ["*.corp", "169.254/16"], pac: false };
  const plan = (env, systemProxy = system) => {
    const { mode, source, https: proxy, noProxy } = resolveProxyPlan({ env, homeDir: home, platform: "darwin", systemProxy });
    return { mode, source, proxy, noProxy };
  };

  assert.deepEqual(plan({}), { mode: "auto", source: "macOS system proxy", proxy: "http://10.0.0.1:8080", noProxy: ["*.corp", "169.254/16"] });
  assert.deepEqual(plan({}, null), { mode: "auto", source: null, proxy: null, noProxy: [] });
  assert.deepEqual(plan({ https_proxy: "http://127.0.0.1:7890", NO_PROXY: "a.test, .b.test" }), {
    mode: "auto",
    source: "HTTPS_PROXY",
    proxy: "http://127.0.0.1:7890",
    noProxy: ["a.test", ".b.test"],
  });
  assert.deepEqual(plan({ ALL_PROXY: "socks5://127.0.0.1:1080" }), { mode: "auto", source: "ALL_PROXY", proxy: "socks5://127.0.0.1:1080", noProxy: [] });

  writeConfig({ proxy: "127.0.0.1:3128" }, home);
  assert.deepEqual(plan({ HTTPS_PROXY: "http://127.0.0.1:7890" }), {
    mode: "url",
    source: "orca-colab proxy setting",
    proxy: "http://127.0.0.1:3128",
    noProxy: [],
  });
  assert.deepEqual(plan({ ORCA_COLAB_PROXY: "off", HTTPS_PROXY: "http://127.0.0.1:7890" }), { mode: "off", source: "ORCA_COLAB_PROXY", proxy: null, noProxy: [] });
  assert.deepEqual(plan({ ORCA_COLAB_PROXY: "auto", HTTPS_PROXY: "http://127.0.0.1:7890" }), {
    mode: "auto",
    source: "HTTPS_PROXY",
    proxy: "http://127.0.0.1:7890",
    noProxy: [],
  });

  assert.throws(() => parseProxySetting("ftp://proxy:21"), { code: "INVALID_PROXY" });
});

test("loopback and NO_PROXY hosts are reached directly", () => {
  const plan = { https: "http://p:1", http: "http://p:1", noProxy: [".corp.test", "exact.test:8443", "10.1/16", "<local>"] };
  const via = (url) => proxyForUrl(plan, url);
  assert.equal(via("https://colab.research.google.com/x"), "http://p:1");
  assert.equal(via("wss://8080-m.colab.dev/colab/tty"), "http://p:1");
  assert.equal(via("http://127.0.0.1:8888/"), null);
  assert.equal(via("http://localhost:3000/"), null);
  assert.equal(via("https://git.corp.test/"), null);
  assert.equal(via("https://exact.test:8443/"), null);
  assert.equal(via("https://exact.test/"), "http://p:1");
  assert.equal(via("https://10.1.200.3/"), null);
  assert.equal(via("https://10.2.0.1/"), "http://p:1");
  assert.equal(via("https://intranet/"), null);
});

test("the macOS and Windows system proxy settings are read", () => {
  assert.deepEqual(
    parseMacSystemProxy(`<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
  SOCKSPort : 7892
  SOCKSProxy : 127.0.0.1
}`),
    { https: "http://127.0.0.1:7891", http: "http://127.0.0.1:7890", socks: null, bypass: ["*.local", "169.254/16"], pac: false },
  );
  assert.deepEqual(
    parseWindowsSystemProxy(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    ProxyOverride    REG_SZ    localhost;*.corp;<local>
`),
    { https: "http://127.0.0.1:7890", http: "http://127.0.0.1:7890", socks: null, bypass: ["localhost", "*.corp", "<local>"], pac: false },
  );
  assert.equal(
    parseWindowsSystemProxy("    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n").https,
    null,
  );
});

test("fetch and a runtime terminal websocket go through the HTTP proxy, with its credentials", async (t) => {
  const home = tempHome(t);
  const origin = await startOriginServer({ handler: jsonOrigin({ name: "term-1" }) });
  const proxy = await startConnectProxy({
    routes: { "runtime.test:80": origin.port },
    requireAuth: `Basic ${Buffer.from("user:p@ss").toString("base64")}`,
  });
  t.after(() => {
    proxy.close();
    origin.close();
  });

  // runtime.test resolves nowhere: an answer can only have come through the proxy.
  installNetworkProxy({ env: { HTTP_PROXY: `http://user:p%40ss@127.0.0.1:${proxy.port}` }, homeDir: home, systemProxy: null });
  const res = await fetch("http://runtime.test/api/status");
  assert.deepEqual(await res.json(), { name: "term-1", path: "/api/status" });
  assert.deepEqual(proxy.connects, ["runtime.test:80"]);

  if (typeof globalThis.WebSocket !== "function") {
    t.diagnostic("no global WebSocket in this Node; websocket leg skipped");
    return;
  }
  const received = [];
  let shell;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no websocket data through the proxy")), 5_000);
    openRuntimeShell({
      baseUrl: "http://runtime.test",
      proxyToken: "proxy-tok",
      onData: (data) => {
        received.push(data);
        clearTimeout(timer);
        resolve();
      },
    }).then((handle) => {
      shell = handle;
    }, reject);
  });
  await shell.close();
  assert.deepEqual(origin.upgrades, [{ url: "/terminals/websocket/term-1", host: "runtime.test", token: "proxy-tok" }]);
  assert.deepEqual(received, ["hello from the runtime"]);
  assert.equal(proxy.connects.every((target) => target === "runtime.test:80"), true);
});

test("a SOCKS5 proxy from ALL_PROXY carries requests, and NO_PROXY hosts skip it", async (t) => {
  const home = tempHome(t);
  const origin = await startOriginServer({ handler: jsonOrigin({ via: "socks" }) });
  const proxy = await startSocksProxy({ routes: { "colab.test:80": origin.port } });
  t.after(() => {
    proxy.close();
    origin.close();
  });

  installNetworkProxy({ env: { ALL_PROXY: proxy.url, NO_PROXY: "direct.test" }, homeDir: home, systemProxy: null });
  assert.deepEqual(await (await fetch("http://colab.test/v1")).json(), { via: "socks", path: "/v1" });
  assert.deepEqual(proxy.connects, ["colab.test:80"]);

  const refused = await fetch("http://other.test/").catch((err) => err);
  assert.equal(refused.code, "NETWORK_UNREACHABLE");
  assert.equal(refused.causeCode, "ECONNREFUSED");
  assert.equal(refused.host, "other.test");
  assert.equal(refused.proxy, proxy.url);
  assert.equal(refused.proxySource, "ALL_PROXY");
});

test("a failed request names the host, the cause code and the proxy, or says that none is in use", async (t) => {
  const home = tempHome(t);
  const proxy = await startConnectProxy();
  const closed = await startOriginServer();
  closed.close();
  t.after(() => proxy.close());

  installNetworkProxy({ env: { HTTP_PROXY: proxy.url }, homeDir: home, systemProxy: null });
  const refused = await fetch("http://relay.test/token", { method: "POST", body: "{}" }).catch((err) => err);
  assert.equal(refused.code, "NETWORK_UNREACHABLE");
  assert.equal(refused.causeCode, "EPROXY_REFUSED");
  assert.match(refused.message, /^Could not reach relay\.test: EPROXY_REFUSED \(the proxy refused to connect to relay\.test:80: HTTP\/1\.1 403 Forbidden\)/);
  assert.equal(refused.message.includes(`through the proxy ${proxy.url} (HTTP_PROXY)`), true);

  installNetworkProxy({ env: { HTTP_PROXY: `http://127.0.0.1:${closed.port}` }, homeDir: home, systemProxy: null });
  const proxyDown = await fetch("http://relay.test/token").catch((err) => err);
  assert.equal(proxyDown.causeCode, "ECONNREFUSED");
  assert.match(proxyDown.message, /The proxy itself failed/);

  installNetworkProxy({ env: {}, homeDir: home, systemProxy: null });
  const direct = await fetch(`http://127.0.0.1:${closed.port}/`).catch((err) => err);
  assert.equal(direct.code, "NETWORK_UNREACHABLE");
  assert.equal(direct.causeCode, "ECONNREFUSED");
  assert.equal(direct.host, `127.0.0.1:${closed.port}`);
  assert.equal(direct.proxy, null);
  assert.match(direct.message, /No proxy is in use\. If this computer reaches Google only through a proxy, set it/);
});

test("sign-in whose token request cannot leave the machine says why on its page, and works on the next try", async (t) => {
  const home = tempHome(t);
  const relay = await startOriginServer({
    handler: (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          scope: "email profile https://www.googleapis.com/auth/colaboratory",
        }),
      );
    },
  });
  const proxy = await startConnectProxy();
  const previousRelay = process.env.ORCA_COLAB_TOKEN_RELAY;
  process.env.ORCA_COLAB_TOKEN_RELAY = "http://relay.test";
  t.after(() => {
    if (previousRelay === undefined) delete process.env.ORCA_COLAB_TOKEN_RELAY;
    else process.env.ORCA_COLAB_TOKEN_RELAY = previousRelay;
    proxy.close();
    relay.close();
  });
  installNetworkProxy({ env: { ALL_PROXY: proxy.url }, homeDir: home, systemProxy: null });

  // Plays the browser: Google's redirect back to the loopback server, consent given.
  const pages = [];
  const openBrowser = async (authUrl) => {
    const auth = new URL(authUrl);
    const back = new URL(auth.searchParams.get("redirect_uri"));
    back.searchParams.set("state", auth.searchParams.get("state"));
    back.searchParams.set("code", "one-time-code");
    void fetch(back).then(async (res) => pages.push({ status: res.status, html: await res.text() }));
  };

  const failure = await runLoopbackOAuthFlow({ homeDir: home, openBrowser }).catch((err) => err);
  assert.equal(failure.code, "NETWORK_UNREACHABLE");
  assert.equal(failure.host, "relay.test");
  assert.equal(failure.causeCode, "EPROXY_REFUSED");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pages[0].status, 500);
  assert.match(pages[0].html, /Could not reach relay\.test: EPROXY_REFUSED/);
  assert.match(pages[0].html, /Setup → Network proxy/);
  assert.match(pages[0].html, /press Sign in again in Orca/);

  proxy.routes["relay.test:80"] = relay.port;
  const status = await runLoopbackOAuthFlow({ homeDir: home, openBrowser });
  assert.equal(status.authenticated, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pages[1].status, 200);
  // The account e-mail lookup at Google was attempted through the proxy too, never directly.
  assert.deepEqual(proxy.connects, ["relay.test:80", "relay.test:80", "www.googleapis.com:443"]);
});

test("the panel's proxy setting is stored for the CLI and shows up in doctor", async (t) => {
  const home = tempHome(t);
  installNetworkProxy({ env: {}, homeDir: home, systemProxy: null });
  const actions = createPanelActions({ homeDir: home, env: {} });

  assert.deepEqual((await actions.setProxy({ proxy: "socks5://user:secret@127.0.0.1:1080" })).proxy, {
    mode: "url",
    source: "orca-colab proxy setting",
    url: "socks5://***@127.0.0.1:1080",
    noProxy: [],
    supported: true,
    warning: null,
  });
  assert.deepEqual(runDoctor({ homeDir: home, env: {}, platform: "linux" }).checks.proxy, {
    ok: true,
    mode: "url",
    source: "orca-colab proxy setting",
    url: "socks5://***@127.0.0.1:1080",
    noProxy: [],
    supported: true,
  });
  assert.equal((await actions.setProxy({ proxy: "off" })).proxy.mode, "off");
  assert.equal((await actions.setProxy({ proxy: "auto" })).proxy.source, null);
  await assert.rejects(actions.setProxy({ proxy: "ftp://x" }), { code: "INVALID_PROXY" });
});

test("doctor --network reaches an HTTPS endpoint through --proxy and reports the ones it cannot", async (t) => {
  const home = tempHome(t);
  const relay = await startOriginServer({
    createServer: (handler) => https.createServer({ cert: TEST_ONLY_CERT, key: TEST_ONLY_KEY }, handler),
    handler: (_req, res) => res.writeHead(200).end("ok"),
  });
  const proxy = await startConnectProxy({ routes: { "relay.test:443": relay.port } });
  t.after(() => {
    proxy.close();
    relay.close();
  });
  const caFile = path.join(home, "test-ca.pem");
  writeFileSync(caFile, TEST_ONLY_CERT);

  const { stdout, code } = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, "--proxy", proxy.url, "doctor", "--network", "--json"],
      {
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: home,
          USERPROFILE: home,
          NODE_EXTRA_CA_CERTS: caFile,
          ORCA_COLAB_TOKEN_RELAY: "https://relay.test",
        },
      },
      (err, out) => resolve({ stdout: out, code: err?.code ?? 0 }),
    );
  });
  const report = JSON.parse(stdout);
  assert.equal(code, 1);
  assert.deepEqual(
    { mode: report.checks.proxy.mode, source: report.checks.proxy.source, url: report.checks.proxy.url },
    { mode: "url", source: "ORCA_COLAB_PROXY", url: proxy.url },
  );
  assert.deepEqual(
    report.checks.network.endpoints.map((e) => [e.name, e.host, e.ok, e.status, e.causeCode, e.proxy]),
    [
      ["token-relay", "relay.test", true, 200, null, proxy.url],
      ["google-token", "oauth2.googleapis.com", false, null, "EPROXY_REFUSED", proxy.url],
      ["google-userinfo", "www.googleapis.com", false, null, "EPROXY_REFUSED", proxy.url],
      ["colab-api", "colaboratory.googleapis.com", false, null, "EPROXY_REFUSED", proxy.url],
      ["colab-web", "colab.research.google.com", false, null, "EPROXY_REFUSED", proxy.url],
    ],
  );
  assert.equal(typeof report.checks.network.endpoints[0].latencyMs, "number");
  assert.deepEqual([...proxy.connects].sort(), [
    "colab.research.google.com:443",
    "colaboratory.googleapis.com:443",
    "oauth2.googleapis.com:443",
    "relay.test:443",
    "www.googleapis.com:443",
  ]);
});
