import { randomBytes, randomUUID } from "node:crypto";
import { COLAB_OAUTH_CONFIG } from "./colab-oauth.mjs";

export const COLAB_HEADERS = Object.freeze({
  "X-Colab-Client-Agent": "vscode",
  "X-Colab-VS-Code-App-Name": "Orca",
  "X-Colab-VS-Code-Extension-Version": "0.9.7",
  Accept: "application/json",
});

export const COLAB_PROXY_TOKEN_HEADER = "X-Colab-Runtime-Proxy-Token";

export function normalizeRuntimeSpec({ gpu = "T4", highRam = false } = {}) {
  const upper = String(gpu || "T4").trim().toUpperCase();
  const shape = highRam ? "SHAPE_HIGHMEM" : "SHAPE_STANDARD";
  if (upper === "CPU" || upper === "NONE") {
    return {
      variant: "VARIANT_CPU",
      accelerator: "NONE",
      shape,
    };
  }
  if (upper.startsWith("TPU")) {
    const accel = upper.replace(/^TPU[\s_-]*/i, "") || "V2_8";
    return {
      variant: "VARIANT_TPU",
      accelerator: accel,
      shape,
    };
  }
  return {
    variant: "VARIANT_GPU",
    accelerator: upper,
    shape,
  };
}

export function stripResourcePrefix(name = "", prefix = "") {
  const str = String(name || "");
  return str.startsWith(prefix) ? str.slice(prefix.length) : str;
}

async function colabJsonRequest(
  url,
  {
    method = "GET",
    accessToken,
    headers = {},
    body,
    fetchImpl = fetch,
    signal,
  } = {},
) {
  const reqHeaders = {
    ...COLAB_HEADERS,
    ...headers,
  };
  if (accessToken) {
    reqHeaders.Authorization = `Bearer ${accessToken}`;
  }
  if (body !== undefined) {
    reqHeaders["Content-Type"] = "application/json";
  }

  const res = await fetchImpl(url.toString(), {
    method,
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Colab API ${method} ${url} failed (${res.status}): ${text}`);
    err.status = res.status;
    err.responseBody = text;
    throw err;
  }

  if (res.status === 204) {
    return {};
  }
  const text = await res.text();
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

export async function listRuntimeSpecs({
  accessToken,
  publicApiDomain = COLAB_OAUTH_CONFIG.colabPublicApiDomain,
  fetchImpl = fetch,
  signal,
} = {}) {
  const url = new URL("/v1beta/runtimespecs", publicApiDomain);
  const data = await colabJsonRequest(url, { accessToken, fetchImpl, signal });
  return Array.isArray(data.runtimeSpecs) ? data.runtimeSpecs : [];
}

export async function listRuntimes({
  accessToken,
  publicApiDomain = COLAB_OAUTH_CONFIG.colabPublicApiDomain,
  fetchImpl = fetch,
  signal,
} = {}) {
  const url = new URL("/v1beta/runtimes", publicApiDomain);
  const data = await colabJsonRequest(url, { accessToken, fetchImpl, signal });
  return Array.isArray(data.runtimes) ? data.runtimes : [];
}

export async function getRuntime({
  runtimeId,
  accessToken,
  publicApiDomain = COLAB_OAUTH_CONFIG.colabPublicApiDomain,
  fetchImpl = fetch,
  signal,
} = {}) {
  const cleanId = stripResourcePrefix(runtimeId, "runtimes/");
  const url = new URL(`/v1beta/runtimes/${encodeURIComponent(cleanId)}`, publicApiDomain);
  return await colabJsonRequest(url, { accessToken, fetchImpl, signal });
}

export async function deleteRuntime({
  runtimeId,
  accessToken,
  publicApiDomain = COLAB_OAUTH_CONFIG.colabPublicApiDomain,
  fetchImpl = fetch,
  signal,
} = {}) {
  const cleanId = stripResourcePrefix(runtimeId, "runtimes/");
  const url = new URL(`/v1beta/runtimes/${encodeURIComponent(cleanId)}`, publicApiDomain);
  url.searchParams.set("allowMissing", "true");
  await colabJsonRequest(url, {
    method: "DELETE",
    accessToken,
    fetchImpl,
    signal,
  });
  return { deleted: true, runtimeId: cleanId };
}

export async function assignRuntime({
  accessToken,
  gpu = "T4",
  highRam = false,
  publicApiDomain = COLAB_OAUTH_CONFIG.colabPublicApiDomain,
  fetchImpl = fetch,
  signal,
} = {}) {
  const runtimeSpec = normalizeRuntimeSpec({ gpu, highRam });
  const createUrl = new URL("/v1beta/runtimes", publicApiDomain);
  createUrl.searchParams.set("requestId", randomUUID());

  let operation = await colabJsonRequest(createUrl, {
    method: "POST",
    accessToken,
    body: { runtimeSpec },
    fetchImpl,
    signal,
  });

  if (!operation.done && operation.name) {
    const opId = stripResourcePrefix(operation.name, "operations/");
    const waitUrl = new URL(
      `/v1/operations/${encodeURIComponent(opId)}:wait`,
      publicApiDomain,
    );
    waitUrl.searchParams.set("timeout", "200s");
    operation = await colabJsonRequest(waitUrl, {
      method: "GET",
      accessToken,
      fetchImpl,
      signal,
    });
  }

  if (operation.error) {
    const msg = operation.error.message || JSON.stringify(operation.error);
    throw new Error(`Colab runtime assignment failed: ${msg}`);
  }

  const runtime = operation.response || operation;
  if (!runtime?.name || !runtime?.connectionInfo?.url || !runtime?.connectionInfo?.token) {
    throw new Error("Colab runtime assignment returned incomplete connectionInfo.");
  }

  const runtimeId = stripResourcePrefix(runtime.name, "runtimes/");
  return {
    id: runtimeId,
    name: runtime.name,
    runtimeSpec: runtime.runtimeSpec || runtimeSpec,
    endpoint: runtime.connectionInfo.endpoint || runtimeId,
    baseUrl: runtime.connectionInfo.url,
    token: runtime.connectionInfo.token,
    tokenExpiry: runtime.connectionInfo.expireTime || null,
  };
}

export async function getConsumptionUserInfo({
  accessToken,
  gapiDomain = COLAB_OAUTH_CONFIG.colabGapiDomain,
  fetchImpl = fetch,
  signal,
} = {}) {
  const url = new URL("/v1/user-info", gapiDomain);
  url.searchParams.set("get_ccu_consumption_info", "true");
  const info = await colabJsonRequest(url, { accessToken, fetchImpl, signal });
  return {
    subscriptionTier: info.subscriptionTier || "SUBSCRIPTION_TIER_UNSPECIFIED",
    paidComputeUnitsBalance:
      typeof info.paidComputeUnitsBalance === "number"
        ? info.paidComputeUnitsBalance
        : null,
    consumptionRateHourly:
      typeof info.consumptionRateHourly === "number"
        ? info.consumptionRateHourly
        : null,
    assignmentsCount:
      typeof info.assignmentsCount === "number" ? info.assignmentsCount : 0,
    eligibleAccelerators: Array.isArray(info.eligibleAccelerators)
      ? info.eligibleAccelerators
      : [],
    freeCcuQuotaInfo: info.freeCcuQuotaInfo || null,
  };
}

export async function getRuntimeResources({
  baseUrl,
  proxyToken,
  fetchImpl = fetch,
  signal,
} = {}) {
  const url = new URL("/api/colab/resources", baseUrl);
  const res = await colabJsonRequest(url, {
    headers: {
      [COLAB_PROXY_TOKEN_HEADER]: proxyToken,
    },
    fetchImpl,
    signal,
  });
  return res;
}

export function buildShellBootstrapScript({
  authKey,
  sshPublicKey,
  loginServer = "",
  hostnameSuffix = "",
}) {
  const suffix = (hostnameSuffix || randomBytes(3).toString("hex"))
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  const hostname = `orca-colab-${suffix}`;
  const payload = JSON.stringify({
    authKey: String(authKey || "").trim(),
    sshPublicKey: String(sshPublicKey || "").trim(),
    loginServer: String(loginServer || "").trim(),
    hostname,
  });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64");

  const pythonScript = `
import base64, json, os, subprocess, sys, time

cfg = json.loads(base64.b64decode("${payloadB64}").decode("utf-8"))
auth_key = cfg["authKey"]
pub_key = cfg["sshPublicKey"]
login_server = cfg["loginServer"]
hostname = cfg["hostname"]

os.makedirs("/root/.orca-colab", mode=0o700, exist_ok=True)
os.makedirs("/root/.ssh", mode=0o700, exist_ok=True)
os.chmod("/root/.ssh", 0o700)

auth_keys = "/root/.ssh/authorized_keys"
existing = open(auth_keys, "r", encoding="utf-8").read().splitlines() if os.path.exists(auth_keys) else []
if pub_key not in [line.strip() for line in existing]:
    existing.append(pub_key)
with open(auth_keys, "w", encoding="utf-8") as f:
    f.write("\\n".join([x for x in existing if x]) + "\\n")
os.chmod(auth_keys, 0o600)

if subprocess.run(["which", "sshd"], capture_output=True).returncode != 0 or subprocess.run(["which", "rsync"], capture_output=True).returncode != 0:
    subprocess.run(["apt-get", "update", "-qq"], check=True)
    subprocess.run(["apt-get", "install", "-y", "-qq", "openssh-server", "rsync"], check=True)

os.makedirs("/run/sshd", mode=0o755, exist_ok=True)
os.makedirs("/etc/ssh/sshd_config.d", mode=0o755, exist_ok=True)
main_sshd = "/etc/ssh/sshd_config"
if os.path.exists(main_sshd):
    txt = open(main_sshd, "r", encoding="utf-8").read()
    if "Include /etc/ssh/sshd_config.d/*.conf" not in txt:
        with open(main_sshd, "w", encoding="utf-8") as f:
            f.write("Include /etc/ssh/sshd_config.d/*.conf\\n" + txt)

with open("/etc/ssh/sshd_config.d/orca-colab.conf", "w", encoding="utf-8") as f:
    f.write("Port 22\\nPort 2222\\nListenAddress 0.0.0.0\\nPermitRootLogin prohibit-password\\nPasswordAuthentication no\\nPubkeyAuthentication yes\\nMaxStartups 10:30:100\\n")

subprocess.run(["ssh-keygen", "-A"], check=False)
if subprocess.run(["service", "ssh", "restart"], capture_output=True).returncode != 0:
    subprocess.run(["pkill", "-x", "sshd"], capture_output=True)
    subprocess.run(["/usr/sbin/sshd"], check=True)

if subprocess.run(["which", "tailscale"], capture_output=True).returncode != 0:
    subprocess.run("curl -fsSL https://tailscale.com/install.sh | sh", shell=True, check=True)

os.makedirs("/var/run/tailscale", mode=0o755, exist_ok=True)
sock = "/var/run/tailscale/tailscaled.sock"
state = "/root/.orca-colab/tailscaled.state"
if subprocess.run(["pgrep", "-x", "tailscaled"], capture_output=True).returncode != 0:
    log_f = open("/root/.orca-colab/tailscaled.log", "ab")
    subprocess.Popen([
        "tailscaled",
        "--tun=userspace-networking",
        "--socks5-server=localhost:1055",
        f"--state={state}",
        f"--socket={sock}",
    ], stdout=log_f, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(30):
        if os.path.exists(sock):
            break
        time.sleep(0.5)

up_cmd = [
    "tailscale",
    f"--socket={sock}",
    "up",
    f"--authkey={auth_key}",
    f"--hostname={hostname}",
    "--accept-dns=false",
    "--accept-routes=false",
    "--reset",
]
if login_server:
    up_cmd.append(f"--login-server={login_server}")
subprocess.run(up_cmd, check=True)

ip_res = subprocess.run(["tailscale", f"--socket={sock}", "ip", "-4"], capture_output=True, text=True, check=True)
ip = ip_res.stdout.strip().splitlines()[0]
with open("/root/.orca-colab/ready", "w", encoding="utf-8") as f:
    f.write(f"{hostname} {ip}\\n")
print(f"ORCA_COLAB_BOOTSTRAP_READY ip={ip} hostname={hostname}", flush=True)
`.trim();

  const pyB64 = Buffer.from(pythonScript, "utf8").toString("base64");
  return {
    hostname,
    command: `python3 -c 'import base64; exec(base64.b64decode("${pyB64}").decode("utf-8"))' || echo "ORCA_COLAB_BOOTSTRAP_ERROR"\n`,
  };
}

export async function runBootstrapOverTty({
  baseUrl,
  proxyToken,
  authKey,
  sshPublicKey,
  loginServer = "",
  hostnameSuffix = "",
  timeoutMs = 180_000,
  WebSocketImpl = globalThis.WebSocket,
  onOutput,
  signal,
} = {}) {
  const { hostname, command } = buildShellBootstrapScript({
    authKey,
    sshPublicKey,
    loginServer,
    hostnameSuffix,
  });

  const wsUrl = new URL("/colab/tty", baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

  return await new Promise((resolve, reject) => {
    let settled = false;
    let transcript = "";

    const ws = new WebSocketImpl(wsUrl.toString(), {
      headers: {
        ...COLAB_HEADERS,
        [COLAB_PROXY_TOKEN_HEADER]: proxyToken,
      },
    });

    const cleanup = () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Ignore close errors.
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Timed out bootstrapping runtime over /colab/tty after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        settled = true;
        cleanup();
        reject(new Error("Bootstrap aborted."));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("Bootstrap aborted."));
        },
        { once: true },
      );
    }

    const handleText = (rawText) => {
      let chunk = rawText;
      try {
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed.data === "string") {
          chunk = parsed.data;
        }
      } catch {
        // Use raw text if not JSON wrapped.
      }

      transcript += chunk;
      if (typeof onOutput === "function") {
        onOutput(chunk);
      }

      const readyMatch = transcript.match(
        /ORCA_COLAB_BOOTSTRAP_READY\s+ip=([0-9.]+)\s+hostname=([a-z0-9-]+)/i,
      );
      if (readyMatch && !settled) {
        settled = true;
        cleanup();
        resolve({
          ok: true,
          ip: readyMatch[1],
          hostname: readyMatch[2],
        });
        return;
      }

      if (transcript.includes("ORCA_COLAB_BOOTSTRAP_ERROR") && !settled) {
        settled = true;
        cleanup();
        reject(new Error(`Colab /colab/tty bootstrap command failed:\n${transcript.slice(-800)}`));
      }
    };

    if (typeof ws.addEventListener === "function") {
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ cols: 120, rows: 40 }));
        ws.send(JSON.stringify({ data: command }));
      });
      ws.addEventListener("message", (event) => {
        const raw =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data).toString("utf8");
        handleText(raw);
      });
      ws.addEventListener("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Colab /colab/tty WebSocket error: ${err?.message || "connection failed"}`));
      });
      ws.addEventListener("close", () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Colab /colab/tty WebSocket closed before bootstrap completed."));
      });
    } else if (typeof ws.on === "function") {
      ws.on("open", () => {
        ws.send(JSON.stringify({ cols: 120, rows: 40 }));
        ws.send(JSON.stringify({ data: command }));
      });
      ws.on("message", (data) => {
        handleText(typeof data === "string" ? data : data.toString("utf8"));
      });
      ws.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
      ws.on("close", () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Colab /colab/tty WebSocket closed before bootstrap completed."));
      });
    }
  });
}
