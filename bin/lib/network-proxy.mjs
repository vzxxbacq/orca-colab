import { spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import { readConfig } from "./colab-home.mjs";

// Node's fetch and WebSocket ignore every proxy setting unless told otherwise (NODE_USE_ENV_PROXY exists
// only from Node 22.21 / 24 and must be set before the process starts, which the Orca app does not do for
// a plugin worker). Here the proxy is found (override, config, environment, system settings), tunnels are
// opened with node:net / node:tls, and Node's built-in HTTP client is pointed at them.

const PLAN_TTL_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_PORTS = { "http:": 80, "https:": 443, "socks:": 1080, "socks5:": 1080, "socks5h:": 1080 };

export class ProxySettingError extends Error {
  constructor(message) {
    super(message);
    this.code = "INVALID_PROXY";
  }
}

// "auto" | "off" | a proxy URL (http, https, socks5). A bare host:port means an HTTP proxy.
export function parseProxySetting(raw) {
  const value = String(raw ?? "").trim();
  if (value === "" || value.toLowerCase() === "auto") {
    return { mode: "auto", url: null };
  }
  if (["off", "none", "direct"].includes(value.toLowerCase())) {
    return { mode: "off", url: null };
  }
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    throw new ProxySettingError(`'${value}' is not a proxy URL (expected auto, off, or for example http://127.0.0.1:7890 or socks5://127.0.0.1:1080).`);
  }
  if (!(parsed.protocol in DEFAULT_PORTS) || !parsed.hostname) {
    throw new ProxySettingError(`Unsupported proxy '${value}': use http://, https:// or socks5://.`);
  }
  return { mode: "url", url: parsed.href.replace(/\/$/, "") };
}

function proxyUrlOrNull(raw) {
  try {
    return parseProxySetting(raw).url;
  } catch {
    return null;
  }
}

// Proxy passwords never reach logs, JSON output or the panel.
export function redactProxyUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    return parsed.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function envValue(env, name) {
  const value = env?.[name.toLowerCase()] ?? env?.[name.toUpperCase()];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function splitList(value) {
  return String(value || "")
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseMacSystemProxy(text) {
  const field = (key) => new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m").exec(text)?.[1] ?? null;
  const entry = (prefix, scheme) =>
    field(`${prefix}Enable`) === "1" && field(`${prefix}Proxy`)
      ? `${scheme}://${field(`${prefix}Proxy`)}:${field(`${prefix}Port`) || (scheme === "http" ? 80 : 1080)}`
      : null;
  const exceptions = /ExceptionsList\s*:\s*<array>\s*{([^}]*)}/.exec(text)?.[1] ?? "";
  return {
    https: entry("HTTPS", "http"),
    http: entry("HTTP", "http"),
    socks: entry("SOCKS", "socks5"),
    bypass: [...exceptions.matchAll(/^\s*\d+\s*:\s*(\S+)\s*$/gm)].map((m) => m[1]),
    pac: field("ProxyAutoConfigEnable") === "1" || field("ProxyAutoDiscoveryEnable") === "1",
  };
}

export function parseWindowsSystemProxy(text) {
  const field = (key) => new RegExp(`^\\s*${key}\\s+REG_\\w+\\s+(.+?)\\s*$`, "mi").exec(text)?.[1] ?? null;
  const out = { https: null, http: null, socks: null, bypass: splitList(field("ProxyOverride")), pac: Boolean(field("AutoConfigURL")) };
  const server = field("ProxyServer");
  if (Number.parseInt(field("ProxyEnable") || "0", 16) !== 1 || !server) {
    return out;
  }
  if (!server.includes("=")) {
    out.https = out.http = proxyUrlOrNull(server);
    return out;
  }
  for (const part of server.split(";")) {
    const [kind, address] = part.split("=");
    if (!address) continue;
    if (kind === "https" || kind === "http") out[kind] = proxyUrlOrNull(address);
    if (kind === "socks") out.socks = proxyUrlOrNull(address.includes("://") ? address : `socks5://${address}`);
  }
  return out;
}

// The Orca app starts the plugin worker without a shell environment, so the system setting is the only
// place a proxy chosen in macOS / Windows settings can be read from.
export function readSystemProxy({ platform = process.platform, run = spawnSync } = {}) {
  try {
    if (platform === "darwin") {
      const res = run("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", timeout: 2_000, windowsHide: true });
      return res.status === 0 ? parseMacSystemProxy(res.stdout) : null;
    }
    if (platform === "win32") {
      const res = run(
        "reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
        { encoding: "utf8", timeout: 2_000, windowsHide: true },
      );
      return res.status === 0 ? parseWindowsSystemProxy(res.stdout) : null;
    }
  } catch {
    // No system setting readable; the environment still applies.
  }
  return null;
}

// Precedence: ORCA_COLAB_PROXY (also set by --proxy), the `proxy` field of ~/.orca-colab/config.json (the
// panel's setting), HTTPS_PROXY / HTTP_PROXY / ALL_PROXY, then the system proxy of macOS or Windows.
export function resolveProxyPlan({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
  systemProxy = readSystemProxy,
} = {}) {
  const plan = { mode: "auto", source: null, https: null, http: null, noProxy: splitList(envValue(env, "NO_PROXY")), warning: null };
  const override = envValue(env, "ORCA_COLAB_PROXY");
  let configured = null;
  try {
    configured = readConfig(homeDir)?.proxy ?? null;
  } catch {
    // An unreadable config means no setting.
  }
  const setting = override ?? configured;
  if (setting) {
    const settingSource = override ? "ORCA_COLAB_PROXY" : "orca-colab proxy setting";
    try {
      const parsed = parseProxySetting(setting);
      plan.mode = parsed.mode;
      if (parsed.mode !== "auto") {
        plan.source = settingSource;
        plan.https = plan.http = parsed.url;
        return plan;
      }
    } catch (err) {
      plan.warning = `${settingSource}: ${err.message}`;
    }
  }

  const all = proxyUrlOrNull(envValue(env, "ALL_PROXY") ?? "off");
  const envHttps = proxyUrlOrNull(envValue(env, "HTTPS_PROXY") ?? "off");
  const envHttp = proxyUrlOrNull(envValue(env, "HTTP_PROXY") ?? "off");
  if (envHttps || envHttp || all) {
    plan.https = envHttps ?? all;
    plan.http = envHttp ?? all;
    plan.source = envHttps ? "HTTPS_PROXY" : all ? "ALL_PROXY" : "HTTP_PROXY";
    return plan;
  }

  const system = typeof systemProxy === "function" ? systemProxy({ platform }) : systemProxy;
  if (system) {
    plan.https = system.https ?? system.socks;
    plan.http = system.http ?? system.socks;
    plan.noProxy = [...plan.noProxy, ...system.bypass];
    if (plan.https || plan.http) {
      plan.source = platform === "win32" ? "Windows system proxy" : "macOS system proxy";
    } else if (system.pac) {
      plan.warning =
        "The system proxy is an automatic configuration (PAC) script, which orca-colab cannot evaluate. Set the proxy URL itself (panel: Setup → Network proxy, or --proxy / ORCA_COLAB_PROXY).";
    }
  }
  return plan;
}

function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
    return null;
  }
  return parts.reduce((acc, p) => acc * 256 + Number(p), 0);
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || /^127\./.test(hostname);
}

// NO_PROXY entries: `*`, host, .suffix, *.suffix, host:port, IPv4 CIDR (macOS writes `169.254/16`) and
// Windows' `<local>` (names without a dot).
function bypasses(entry, hostname, port) {
  let rule = entry.toLowerCase();
  if (rule === "*") return true;
  if (rule === "<local>") return !hostname.includes(".");
  const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(rule);
  if (cidr) {
    const octets = cidr[1].split(".");
    const base = ipv4ToInt([...octets, "0", "0", "0"].slice(0, 4).join("."));
    const target = ipv4ToInt(hostname);
    const bits = Number(cidr[2]);
    if (base === null || target === null || bits > 32) return false;
    const size = 2 ** (32 - bits);
    return Math.floor(base / size) === Math.floor(target / size);
  }
  const withPort = /^(.+):(\d+)$/.exec(rule);
  if (withPort && !rule.includes("]") && rule.split(":").length === 2) {
    if (String(port) !== withPort[2]) return false;
    rule = withPort[1];
  }
  rule = rule.replace(/^\*?\./, "");
  if (rule.includes("*")) {
    const pattern = new RegExp(`^${rule.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return pattern.test(hostname);
  }
  return hostname === rule || hostname.endsWith(`.${rule}`);
}

// The proxy URL a request to `url` goes through under `plan`, or null for a direct connection.
export function proxyForUrl(plan, url) {
  let target;
  try {
    target = new URL(String(url));
  } catch {
    return null;
  }
  const secure = target.protocol === "https:" || target.protocol === "wss:";
  const proxy = secure ? plan?.https : plan?.http;
  if (!proxy) return null;
  const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLoopback(hostname)) return null;
  const port = target.port || (secure ? 443 : 80);
  return plan.noProxy.some((entry) => bypasses(entry, hostname, port)) ? null : proxy;
}

function proxyError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, proxyStage: true, ...extra });
}

// Resolves with exactly `need(buffer)` bytes consumed from the socket; what follows stays unread.
function readFromSocket(socket, need) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const done = (err, value) => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      let length;
      try {
        length = need(buffered);
      } catch (err) {
        done(err);
        return;
      }
      if (length === null) return;
      socket.pause();
      if (buffered.length > length) socket.unshift(buffered.subarray(length));
      done(null, buffered.subarray(0, length));
    };
    const onError = (err) => done(err);
    const onClose = () => done(proxyError("ECONNRESET", "the proxy closed the connection before answering"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

function hostPort(host, port) {
  return net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
}

async function httpConnect(socket, proxy, host, port) {
  const target = hostPort(host, port);
  const auth =
    proxy.username || proxy.password
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
      : "";
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}Proxy-Connection: Keep-Alive\r\n\r\n`);
  const head = await readFromSocket(socket, (buf) => {
    const end = buf.indexOf("\r\n\r\n");
    if (end === -1 && buf.length > 16_384) throw proxyError("EPROXY_PROTOCOL", "the proxy sent no valid answer to CONNECT");
    return end === -1 ? null : end + 4;
  });
  const statusLine = head.toString("latin1").split("\r\n")[0];
  const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(statusLine)?.[1]);
  if (!(status >= 200 && status < 300)) {
    throw proxyError(
      status === 407 ? "EPROXY_AUTH" : "EPROXY_REFUSED",
      status === 407
        ? "the proxy asks for a user name and password (407); put them in the proxy URL: http://user:password@host:port"
        : `the proxy refused to connect to ${target}: ${statusLine || "no HTTP answer"}`,
      { proxyStatus: status || null },
    );
  }
}

const SOCKS_REPLIES = {
  1: ["EPROXY_REFUSED", "general failure"],
  2: ["EPROXY_REFUSED", "connection not allowed by the proxy's rules"],
  3: ["ENETUNREACH", "network unreachable"],
  4: ["EHOSTUNREACH", "host unreachable"],
  5: ["ECONNREFUSED", "connection refused"],
  6: ["ETIMEDOUT", "timed out"],
};

// SOCKS5 (RFC 1928 / 1929). The host name is always sent to the proxy to resolve.
async function socksConnect(socket, proxy, host, port) {
  const user = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  socket.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]));
  const choice = await readFromSocket(socket, (buf) => (buf.length >= 2 ? 2 : null));
  if (choice[0] !== 5) {
    throw proxyError("EPROXY_PROTOCOL", "the proxy did not answer as a SOCKS5 proxy");
  }
  if (choice[1] === 2) {
    const u = Buffer.from(user);
    const p = Buffer.from(password);
    socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const ok = await readFromSocket(socket, (buf) => (buf.length >= 2 ? 2 : null));
    if (ok[1] !== 0) throw proxyError("EPROXY_AUTH", "the SOCKS5 proxy rejected the user name and password");
  } else if (choice[1] !== 0) {
    throw proxyError("EPROXY_AUTH", "the SOCKS5 proxy asks for a user name and password; put them in the proxy URL");
  }
  const address = net.isIPv4(host)
    ? Buffer.from([1, ...host.split(".").map(Number)])
    : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)]);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 0xff])]));
  const reply = await readFromSocket(socket, (buf) => {
    if (buf.length < 5) return null;
    const total = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
    return buf.length >= total ? total : null;
  });
  if (reply[1] !== 0) {
    const [code, text] = SOCKS_REPLIES[reply[1]] || ["EPROXY_REFUSED", `error ${reply[1]}`];
    throw proxyError(code, `the SOCKS5 proxy could not connect to ${hostPort(host, port)}: ${text}`);
  }
}

function waitFor(socket, event) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    socket.once("error", onError);
    socket.once(event, () => {
      socket.off("error", onError);
      resolve();
    });
  });
}

// A socket to host:port through `proxyUrl`: CONNECT for http(s) proxies, SOCKS5 otherwise. With `secure`,
// TLS to the target is started inside the tunnel, so the proxy only ever sees ciphertext.
export async function openProxyTunnel({ proxyUrl, host, port, secure = true, servername = null, timeoutMs = CONNECT_TIMEOUT_MS }) {
  const proxy = new URL(proxyUrl);
  const proxyPort = Number(proxy.port) || DEFAULT_PORTS[proxy.protocol];
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
  let socket =
    proxy.protocol === "https:"
      ? tls.connect({ host: proxyHost, port: proxyPort, servername: net.isIP(proxyHost) ? undefined : proxyHost })
      : net.connect({ host: proxyHost, port: proxyPort });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(proxyError("ETIMEDOUT", `no answer through the proxy within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
  });
  // A late socket error after the race is lost must not crash the process.
  const swallow = () => {};
  socket.on("error", swallow);
  try {
    await Promise.race([
      timeout,
      (async () => {
        try {
          await waitFor(socket, proxy.protocol === "https:" ? "secureConnect" : "connect");
          if (proxy.protocol.startsWith("socks")) {
            await socksConnect(socket, proxy, host, port);
          } else {
            await httpConnect(socket, proxy, host, port);
          }
        } catch (err) {
          throw Object.assign(err, { proxyStage: true });
        }
        if (secure) {
          const inner = tls.connect({
            socket,
            servername: servername || (net.isIP(host) ? undefined : host),
            ALPNProtocols: ["http/1.1"],
          });
          inner.on("error", swallow);
          socket = inner;
          await waitFor(inner, "secureConnect");
        }
      })(),
    ]);
  } catch (err) {
    socket.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  socket.off("error", swallow);
  socket.setNoDelay(true);
  socket.resume();
  return socket;
}

const state = {
  installed: false,
  supported: null,
  native: false,
  Agent: null,
  agents: new Map(),
  options: {},
  plan: null,
  planAt: 0,
};

// The plan in force, re-read every few seconds so a long-lived worker follows a changed setting.
export function currentProxyPlan() {
  if (!state.plan || Date.now() - state.planAt > PLAN_TTL_MS) {
    state.plan = resolveProxyPlan(state.options);
    state.planAt = Date.now();
  }
  return state.plan;
}

export function refreshProxyPlan() {
  state.plan = null;
}

// Node's own env-proxy mode honours the proxy variables by itself, and nothing else.
function usable(plan) {
  return state.supported === true || (state.native && /_PROXY$/.test(plan.source || "") && plan.source !== "ORCA_COLAB_PROXY");
}

// Where a request to `url` goes right now: { proxy (redacted), source } or null when direct.
export function proxyRouteFor(url) {
  if (!state.installed || !usable(currentProxyPlan())) return null;
  const plan = currentProxyPlan();
  const proxy = proxyForUrl(plan, url);
  return proxy ? { proxy: redactProxyUrl(proxy), source: plan.source } : null;
}

export function describeProxyPlan(plan = currentProxyPlan()) {
  return {
    mode: plan.mode,
    source: plan.source,
    url: redactProxyUrl(plan.https ?? plan.http),
    noProxy: plan.noProxy,
    supported: state.supported !== false,
    warning:
      plan.warning ??
      (state.supported === false && (plan.https || plan.http) && !usable(plan)
        ? state.native
          ? "NODE_USE_ENV_PROXY / --use-env-proxy is on, so Node's own proxy handling is in charge and only the proxy variables (HTTPS_PROXY, HTTP_PROXY, NO_PROXY) apply. Unset it to let this setting apply."
          : "A proxy is configured, but this Node.js build does not expose the HTTP client hook orca-colab needs to use it."
        : null),
  };
}

function agentFor(proxyUrl) {
  let agent = state.agents.get(proxyUrl);
  if (!agent) {
    agent = new state.Agent({
      connect(opts, callback) {
        const secure = opts.protocol === "https:";
        openProxyTunnel({
          proxyUrl,
          host: String(opts.hostname).replace(/^\[|\]$/g, ""),
          port: Number(opts.port) || (secure ? 443 : 80),
          secure,
          servername: opts.servername || null,
        }).then(
          (socket) => callback(null, socket),
          (err) => callback(err, null),
        );
      },
    });
    state.agents.set(proxyUrl, agent);
  }
  return agent;
}

// Node bundles its HTTP client (undici) without exporting it; its process-wide dispatcher sits under a
// well-known symbol (".1" up to Node 24, ".2" from Node 26). Requests that need no proxy keep going to the
// dispatcher Node created, untouched.
function installDispatcher() {
  void globalThis.Headers;
  const legacy = Symbol.for("undici.globalDispatcher.1");
  const modern = Symbol.for("undici.globalDispatcher.2");
  const direct = globalThis[modern] ?? globalThis[legacy];
  const Agent = direct?.constructor;
  // Under NODE_USE_ENV_PROXY / --use-env-proxy Node installs its own proxying dispatcher; it stays in charge.
  if (typeof direct?.dispatch !== "function" || typeof Agent !== "function") {
    return false;
  }
  if (Agent.name !== "Agent") {
    state.native = true;
    return false;
  }
  try {
    void new Agent({ connect() {} });
  } catch {
    return false;
  }
  state.Agent = Agent;
  const routed = {
    dispatch(opts, handler) {
      const proxy = proxyForUrl(currentProxyPlan(), opts.origin);
      return (proxy ? agentFor(proxy) : direct).dispatch(opts, handler);
    },
    close: (...args) => direct.close(...args),
    destroy: (...args) => direct.destroy(...args),
  };
  for (const symbol of [modern, legacy]) {
    if (globalThis[symbol]?.constructor === Agent) {
      globalThis[symbol] = routed;
    }
  }
  return true;
}

const CERTIFICATE_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/;

function rootCause(err) {
  let cause = err;
  for (let depth = 0; depth < 6 && cause?.cause; depth += 1) {
    cause = cause.cause;
  }
  if (Array.isArray(cause?.errors) && cause.errors.length > 0 && !cause.code) {
    cause = cause.errors[0];
  }
  return cause;
}

// Node reports every unreachable host as "fetch failed". This names the host, the cause code and the
// proxy in use, and says where a proxy is set. `cause` stays the low-level error.
export function describeNetworkFailure(err, target) {
  if (!(err instanceof TypeError) || !err.cause) {
    return null;
  }
  let url;
  try {
    url = new URL(String(target?.url ?? target));
  } catch {
    return null;
  }
  const cause = rootCause(err);
  const rawCode = cause?.code || cause?.name || "ERROR";
  const causeCode = rawCode === "UND_ERR_CONNECT_TIMEOUT" ? "ETIMEDOUT" : rawCode;
  const route = proxyRouteFor(url);
  const via = route ? ` through the proxy ${route.proxy} (${route.source})` : "";
  const plan = state.installed ? describeProxyPlan() : null;
  const hint = CERTIFICATE_CODES.test(causeCode)
    ? "The server's certificate was not trusted; a proxy that inspects TLS needs its CA certificate in NODE_EXTRA_CA_CERTS."
    : route
      ? `${cause?.proxyStage ? "The proxy itself failed" : "The proxy was reached but the host was not"}: check that it is running and allows this host, or change it (panel: Setup → Network proxy; CLI: --proxy <url|off> or ORCA_COLAB_PROXY). 'orca-colab doctor --network' tests every endpoint.`
      : `${plan?.warning ?? "No proxy is in use."} If this computer reaches Google only through a proxy, set it (panel: Setup → Network proxy; CLI: --proxy <url>, ORCA_COLAB_PROXY or HTTPS_PROXY). 'orca-colab doctor --network' tests every endpoint.`;
  const detail = `${causeCode}${via}`;
  const failure = new Error(`Could not reach ${url.host}: ${causeCode} (${cause?.message || "no details"})${via}. ${hint}`, { cause });
  return Object.assign(failure, {
    name: "NetworkError",
    code: "NETWORK_UNREACHABLE",
    host: url.host,
    causeCode,
    proxy: route?.proxy ?? null,
    proxySource: route?.source ?? null,
    detail,
    hint,
  });
}

function installFetchDescriptions() {
  const baseFetch = globalThis.fetch;
  if (typeof baseFetch !== "function" || baseFetch.describesNetworkFailures) {
    return;
  }
  const described = async function fetch(input, init) {
    try {
      return await baseFetch(input, init);
    } catch (err) {
      throw describeNetworkFailure(err, input) ?? err;
    }
  };
  described.describesNetworkFailures = true;
  globalThis.fetch = described;
}

// Call once per process, before the first request; later calls only update where settings are read from.
export function installNetworkProxy({ env = process.env, homeDir = os.homedir(), platform = process.platform, systemProxy = readSystemProxy } = {}) {
  state.options = { env, homeDir, platform, systemProxy };
  state.plan = null;
  if (!state.installed) {
    state.installed = true;
    try {
      state.supported = installDispatcher();
    } catch {
      state.supported = false;
    }
    installFetchDescriptions();
  }
  return { supported: state.supported };
}
