import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { COLAB_OAUTH_CONFIG } from "./colab-oauth.mjs";

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

export const COLAB_HEADERS = Object.freeze({
  "User-Agent": `orca-colab/${PACKAGE_VERSION}`,
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
  if (upper.includes("6000") || upper.includes("BLACKWELL") || upper === "G4") {
    return {
      variant: "VARIANT_GPU",
      accelerator: "G4",
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
  const text = (await res.text()).replace(/^\)\]\}'\r?\n?/, "").trim();
  if (!text) {
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
  reuseExisting = true,
  excludeRuntimeIds = [],
  maxAttempts = 3,
  onProgress = null,
  publicApiDomain = COLAB_OAUTH_CONFIG.colabPublicApiDomain,
  fetchImpl = fetch,
  signal,
} = {}) {
  const runtimeSpec = normalizeRuntimeSpec({ gpu, highRam });
  const excluded = new Set(
    (excludeRuntimeIds || []).map((id) => stripResourcePrefix(id, "runtimes/")),
  );

  if (reuseExisting) {
    try {
      const existingList = await listRuntimes({
        accessToken,
        publicApiDomain,
        fetchImpl,
        signal,
      });
      for (const rt of existingList) {
        const rtId = stripResourcePrefix(rt?.name || "", "runtimes/");
        if (
          rtId &&
          !excluded.has(rtId) &&
          rt?.connectionInfo?.url &&
          rt?.connectionInfo?.token &&
          rt?.runtimeSpec?.variant === runtimeSpec.variant &&
          (rt?.runtimeSpec?.accelerator || "NONE") === runtimeSpec.accelerator
        ) {
          if (typeof onProgress === "function") {
            onProgress(
              `Reusing active Colab ${gpu} runtime (${rtId})...`,
            );
          }
          return {
            id: rtId,
            name: rt.name,
            runtimeSpec: rt.runtimeSpec || runtimeSpec,
            endpoint: rt.connectionInfo.endpoint || rtId,
            baseUrl: rt.connectionInfo.url,
            token: rt.connectionInfo.token,
            tokenExpiry: rt.connectionInfo.expireTime || null,
          };
        }
      }
    } catch {
      // Proceed to fresh runtime creation if listing fails.
    }
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error("Runtime assignment aborted.");
    }
    if (attempt > 1 && typeof onProgress === "function") {
      onProgress(
        `Colab GPU pool busy; retrying ${gpu} assignment (attempt ${attempt}/${maxAttempts})...`,
      );
    }

    const createUrl = new URL("/v1beta/runtimes", publicApiDomain);
    createUrl.searchParams.set("requestId", randomUUID());

    let operation = await colabJsonRequest(createUrl, {
      method: "POST",
      accessToken,
      body: { runtimeSpec },
      fetchImpl,
      signal,
    });

    const opName = operation.name;
    const pendingRuntimeId = stripResourcePrefix(
      operation?.metadata?.runtime || "",
      "runtimes/",
    );
    let pollCount = 0;
    let pollTimedOut = false;
    while (!operation.done && opName && pollCount < 2) {
      pollCount += 1;
      const opId = stripResourcePrefix(opName, "operations/");
      const waitUrl = new URL(
        `/v1/operations/${encodeURIComponent(opId)}:wait`,
        publicApiDomain,
      );
      waitUrl.searchParams.set("timeout", "10s");
      const pollSignal =
        signal ||
        (typeof AbortSignal?.timeout === "function"
          ? AbortSignal.timeout(12_000)
          : undefined);
      try {
        operation = await colabJsonRequest(waitUrl, {
          method: "GET",
          accessToken,
          fetchImpl,
          signal: pollSignal,
        });
      } catch (pollErr) {
        if (!signal?.aborted) {
          pollTimedOut = true;
        } else {
          throw pollErr;
        }
      }

      if (!operation?.done) {
        try {
          const currentList = await listRuntimes({
            accessToken,
            publicApiDomain,
            fetchImpl,
            signal,
          });
          const readyRt = currentList.find((rt) => {
            const rtId = stripResourcePrefix(rt?.name || "", "runtimes/");
            return (
              rtId &&
              (rtId === pendingRuntimeId || !excluded.has(rtId)) &&
              rt?.connectionInfo?.url &&
              rt?.connectionInfo?.token &&
              rt?.runtimeSpec?.variant === runtimeSpec.variant &&
              (rt?.runtimeSpec?.accelerator || "NONE") ===
                runtimeSpec.accelerator
            );
          });
          if (readyRt) {
            operation = { done: true, response: readyRt };
            pollTimedOut = false;
            break;
          }
        } catch {
          // Ignore fallback list check error.
        }
      }
    }

    if (pollTimedOut && !operation.done) {
      lastError = new Error("Colab runtime assignment timed out waiting for operation; retrying...");
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw lastError;
    }

    if (operation.error) {
      const msg = operation.error.message || JSON.stringify(operation.error);
      lastError = new Error(`Colab runtime assignment failed: ${msg}`);
      const isTransientDeadline =
        msg.includes("deadline exceeded") || msg.includes("assignWithRetry");
      if (isTransientDeadline && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw lastError;
    }

    const runtime = operation.response || operation;
    if (
      !runtime?.name ||
      !runtime?.connectionInfo?.url ||
      !runtime?.connectionInfo?.token
    ) {
      throw new Error(
        "Colab runtime assignment returned incomplete connectionInfo.",
      );
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

  throw lastError || new Error("Colab runtime assignment failed.");
}

// colab.pa.googleapis.com/v1/user-info rejects third-party OAuth clients; the session backend behind
// colab.research.google.com/tun/m accepts any token with the colaboratory scope. It reports no tier.
export async function getConsumptionUserInfo({
  accessToken,
  apiDomain = COLAB_OAUTH_CONFIG.colabApiDomain,
  fetchImpl = fetch,
  signal,
} = {}) {
  const url = new URL("/tun/m/ccu-info", apiDomain);
  url.searchParams.set("authuser", "0");
  const info = await colabJsonRequest(url, { accessToken, fetchImpl, signal });
  return {
    subscriptionTier: null,
    paidComputeUnitsBalance: typeof info.currentBalance === "number" ? info.currentBalance : null,
    consumptionRateHourly:
      typeof info.consumptionRateHourly === "number"
        ? info.consumptionRateHourly
        : null,
    assignmentsCount:
      typeof info.assignmentsCount === "number" ? info.assignmentsCount : null,
    eligibleAccelerators: [
      ...(Array.isArray(info.eligibleGpus) ? info.eligibleGpus : []),
      ...(Array.isArray(info.eligibleTpus) ? info.eligibleTpus : []),
    ],
  };
}

export async function getRuntimeResources({
  baseUrl,
  proxyToken,
  fetchImpl = fetch,
  signal,
  timeoutMs = 4000,
} = {}) {
  const url = new URL("/api/colab/resources", baseUrl);
  const effectiveSignal =
    signal ||
    (typeof AbortSignal?.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined);
  const res = await colabJsonRequest(url, {
    headers: {
      [COLAB_PROXY_TOKEN_HEADER]: proxyToken,
    },
    fetchImpl,
    signal: effectiveSignal,
  });
  return res;
}

export async function execCommandOverTty({
  baseUrl,
  proxyToken,
  command,
  cwd = null,
  envVars = {},
  stdinBase64 = null,
  timeoutMs = 3_600_000,
  WebSocketImpl = globalThis.WebSocket,
  onOutput = null,
  signal = null,
} = {}) {
  const runId = randomBytes(6).toString("hex");
  const startMarker = `__ORCA_START_${runId}__`;
  const modeB64Marker = `__ORCA_MODE_B64_${runId}__`;
  const endPrefix = `__ORCA_END_${runId}:`;
  const endSuffix = `__`;

  const cmdList =
    Array.isArray(command) && command.length > 1
      ? command.map((a) => String(a))
      : null;
  const cmdStr = Array.isArray(command)
    ? command.join(" ")
    : String(command || "");

  const payload = JSON.stringify({
    runId,
    cmd: cmdStr,
    cmdList,
    cwd: cwd || null,
    env: envVars || {},
    stdinB64: stdinBase64 || null,
    startMarker,
    modeB64Marker,
    endPrefix,
    endSuffix,
  });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64");

  const pyRunner = [
    "import base64, json, os, subprocess, sys",
    `cfg = json.loads(base64.b64decode("${payloadB64}").decode("utf-8"))`,
    'if cfg.get("cwd"):',
    '    os.makedirs(cfg["cwd"], exist_ok=True)',
    '    os.chdir(cfg["cwd"])',
    "env = os.environ.copy()",
    'for k, v in (cfg.get("env") or {}).items():',
    "    env[str(k)] = str(v)",
    'sys.stdout.write("\\n" + cfg["startMarker"] + "\\n" + cfg["modeB64Marker"] + "\\n")',
    "sys.stdout.flush()",
    'stdin_bytes = base64.b64decode(cfg["stdinB64"]) if cfg.get("stdinB64") else None',
    'cmd_arg = cfg["cmdList"] if cfg.get("cmdList") else cfg["cmd"]',
    'use_shell = False if cfg.get("cmdList") else True',
    "proc = subprocess.Popen(cmd_arg, shell=use_shell, env=env, stdin=subprocess.PIPE if stdin_bytes is not None else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)",
    "if stdin_bytes is not None:",
    "    proc.stdin.write(stdin_bytes)",
    "    proc.stdin.close()",
    "seq = 0",
    "fd = proc.stdout.fileno()",
    "while True:",
    "    chunk = os.read(fd, 1024)",
    "    if not chunk:",
    "        break",
    "    for i in range(0, len(chunk), 36):",
    '        b64 = base64.b64encode(chunk[i:i+36]).decode("ascii")',
    '        sys.stdout.write("\\n__ORCA_B64_" + cfg["runId"] + "_" + str(seq) + ":" + b64 + "__\\n")',
    "        seq += 1",
    "    sys.stdout.flush()",
    "rc = proc.wait()",
    'sys.stdout.write("\\n" + cfg["endPrefix"] + str(rc) + cfg["endSuffix"] + "\\n")',
    "sys.stdout.flush()",
  ].join("\n");

  const pyB64 = Buffer.from(pyRunner, "utf8").toString("base64");
  const tmpPy = `/tmp/.orca-colab-exec-${runId}.py`;
  const shellLine = `stty -echo 2>/dev/null; printf '%s' "${pyB64}" | base64 -d > ${tmpPy} && python3 -u ${tmpPy}; rm -f ${tmpPy}\n`;

  const wsUrl = new URL("/colab/tty", baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

  return await new Promise((resolve, reject) => {
    let settled = false;
    let rawBuffer = "";
    let started = false;
    let emittedLen = 0;
    const seenSeqs = new Set();
    let framedOutput = "";

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
      reject(
        new Error(
          `Timed out executing command over /colab/tty after ${Math.round(timeoutMs / 1000)}s.`,
        ),
      );
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        settled = true;
        cleanup();
        reject(new Error("Command execution aborted."));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          if (settled) return;
          settled = true;
          try {
            ws.send(JSON.stringify({ data: "\x03\n" }));
          } catch {
            // Ignore.
          }
          cleanup();
          reject(new Error("Command execution aborted."));
        },
        { once: true },
      );
    }

    const b64FrameRegex = new RegExp(
      `__ORCA_B64_${runId}_(\\d+):([A-Za-z0-9+/=]+)__`,
      "g",
    );

    const processIncoming = (rawText) => {
      let chunk = rawText;
      try {
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed.data === "string") {
          chunk = parsed.data;
        }
      } catch {
        // Raw text frame.
      }

      rawBuffer += chunk;

      if (!started) {
        const startIdx = rawBuffer.indexOf(startMarker);
        if (startIdx === -1) {
          return;
        }
        started = true;
        const afterStart = startIdx + startMarker.length;
        rawBuffer = rawBuffer.slice(afterStart).replace(/^\r?\n/, "");
      }

      const isB64Mode =
        rawBuffer.includes(modeB64Marker) ||
        rawBuffer.includes(`__ORCA_B64_${runId}_`);

      if (isB64Mode) {
        b64FrameRegex.lastIndex = 0;
        let match;
        while ((match = b64FrameRegex.exec(rawBuffer)) !== null) {
          const seq = Number.parseInt(match[1], 10);
          if (!seenSeqs.has(seq)) {
            seenSeqs.add(seq);
            const decoded = Buffer.from(match[2], "base64").toString("utf8");
            framedOutput += decoded;
            if (typeof onOutput === "function" && decoded) {
              onOutput(decoded);
            }
          }
        }
      }

      const endRegex = new RegExp(`${endPrefix}(-?\\d+)${endSuffix}`);
      const endMatch = rawBuffer.match(endRegex);

      if (!isB64Mode) {
        const cleanUpTo = endMatch
          ? endMatch.index
          : Math.max(0, rawBuffer.length - 48);
        if (cleanUpTo > emittedLen) {
          const delta = rawBuffer.slice(emittedLen, cleanUpTo);
          emittedLen = cleanUpTo;
          if (typeof onOutput === "function" && delta) {
            onOutput(delta);
          }
        }
      }

      if (endMatch && !settled) {
        settled = true;
        const exitCode = Number.parseInt(endMatch[1], 10);
        const fullOutput = isB64Mode
          ? framedOutput.replace(/\r?\n$/, "")
          : rawBuffer.slice(0, endMatch.index).replace(/\r?\n$/, "");
        cleanup();
        resolve({
          ok: exitCode === 0,
          exitCode: Number.isFinite(exitCode) ? exitCode : 1,
          stdout: fullOutput,
          stderr: "",
        });
      }
    };

    const onOpen = () => {
      ws.send(JSON.stringify({ data: shellLine }));
    };

    if (typeof ws.addEventListener === "function") {
      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", (event) => {
        const raw =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data).toString("utf8");
        processIncoming(raw);
      });
      ws.addEventListener("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Error(
            `Colab /colab/tty WebSocket error: ${err?.message || "connection failed"}`,
          ),
        );
      });
      ws.addEventListener("close", () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Colab /colab/tty WebSocket closed before command finished."));
      });
    } else if (typeof ws.on === "function") {
      ws.on("open", onOpen);
      ws.on("message", (data) => {
        processIncoming(typeof data === "string" ? data : data.toString("utf8"));
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
        reject(new Error("Colab /colab/tty WebSocket closed before command finished."));
      });
    }
  });
}

export async function queryGpuOverTty({
  baseUrl,
  proxyToken,
  WebSocketImpl = globalThis.WebSocket,
  signal = null,
} = {}) {
  try {
    const res = await execCommandOverTty({
      baseUrl,
      proxyToken,
      command:
        "nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>/dev/null || echo 'CPU,0,none'",
      timeoutMs: 20_000,
      WebSocketImpl,
      signal,
    });
    const firstLine = (res.stdout || "")
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (firstLine) {
      const parts = firstLine.split(",").map((s) => s.trim());
      if (parts[0] && parts[0] !== "CPU") {
        return {
          name: parts[0],
          memoryTotalMiB: Number.parseInt(parts[1] || "0", 10) || null,
          driverVersion: parts[2] || null,
        };
      }
    }
  } catch {
    // Fall back below.
  }
  return {
    name: "Colab Runtime",
    memoryTotalMiB: null,
    driverVersion: null,
  };
}

export async function runInteractiveTtySession({
  baseUrl,
  proxyToken,
  cwd = null,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  const wsUrl = new URL("/colab/tty", baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

  return await new Promise((resolve) => {
    const ws = new WebSocketImpl(wsUrl.toString(), {
      headers: {
        ...COLAB_HEADERS,
        [COLAB_PROXY_TOKEN_HEADER]: proxyToken,
      },
    });

    const wasRaw = Boolean(process.stdin.isRaw);
    const cleanup = (code = 0) => {
      try {
        if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
          process.stdin.setRawMode(wasRaw);
        }
        process.stdin.pause();
      } catch {
        // Ignore.
      }
      try {
        ws.close();
      } catch {
        // Ignore.
      }
      resolve(code);
    };

    const sendResize = () => {
      try {
        ws.send(
          JSON.stringify({
            cols: process.stdout.columns || 120,
            rows: process.stdout.rows || 36,
          }),
        );
      } catch {
        // Ignore.
      }
    };

    const onOpen = () => {
      sendResize();
      if (cwd) {
        ws.send(JSON.stringify({ data: `cd ${JSON.stringify(cwd)} && clear\n` }));
      }
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.on("data", (chunk) => {
        try {
          ws.send(JSON.stringify({ data: chunk.toString("utf8") }));
        } catch {
          // Ignore.
        }
      });
      process.stdout.on("resize", sendResize);
    };

    const onMessage = (rawText) => {
      try {
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed.data === "string") {
          process.stdout.write(parsed.data);
          return;
        }
      } catch {
        // Raw text.
      }
      process.stdout.write(rawText);
    };

    if (typeof ws.addEventListener === "function") {
      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", (event) => {
        const raw =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data).toString("utf8");
        onMessage(raw);
      });
      ws.addEventListener("close", () => cleanup(0));
      ws.addEventListener("error", () => cleanup(1));
    } else if (typeof ws.on === "function") {
      ws.on("open", onOpen);
      ws.on("message", (data) =>
        onMessage(typeof data === "string" ? data : data.toString("utf8")),
      );
      ws.on("close", () => cleanup(0));
      ws.on("error", () => cleanup(1));
    }
  });
}
