import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_ABORTED,
  EXIT_ERROR,
  EXIT_OK,
  log,
  writeJson,
} from "../lib/cli-output.mjs";
import { copyToClipboard } from "../lib/clipboard.mjs";
import {
  assignRuntime as defaultAssignRuntime,
  queryGpuOverTty as defaultQueryGpuOverTty,
  runBootstrapOverTty as defaultRunBootstrapOverTty,
} from "../lib/colab-api-client.mjs";
import {
  detectRunningSystemBrowser,
  locateOrcaBinary,
  stepSystemBrowserColab,
} from "../lib/colab-browser-automation.mjs";
import {
  getColabPaths,
  isValidAuthKey,
  readConfig,
  resolveAccount,
  resolveAgentPolicy,
} from "../lib/colab-home.mjs";
import { getValidAccessToken } from "../lib/colab-oauth.mjs";
import { recordSessionStartEvent } from "../lib/credit-ledger.mjs";
import { BOOTSTRAP_NOTEBOOK_COLAB_URL, openUrl } from "../lib/open-url.mjs";
import { resolveGpuRate as resolveRateFromTable } from "../lib/rate-table.mjs";
import { listSessions, writeSession } from "../lib/session-store.mjs";
import { waitForSshBanner } from "../lib/ssh-banner-probe.mjs";
import { queryRemoteGpu } from "../lib/ssh-exec.mjs";
import { getTailscaleStatus } from "../lib/tailscale-cli.mjs";
import {
  findNewColabPeer,
  snapshotOnlinePeers,
  waitForColabPeer,
} from "../lib/tailscale-peer-wait.mjs";

export async function run(
  argv,
  {
    json,
    stdout,
    stderr,
    env,
    homeDir,
    signal = null,
    fetchTailscaleStatus = null,
    probeSshBanner = null,
    runSsh = null,
    openBrowser = openUrl,
    copyClipboard = copyToClipboard,
    resolveGpuRate = resolveRateFromTable,
    onSessionStart = recordSessionStartEvent,
    assignRuntimeFn = defaultAssignRuntime,
    bootstrapTtyFn = defaultRunBootstrapOverTty,
    queryGpuTtyFn = defaultQueryGpuOverTty,
    fetchImpl = fetch,
    WebSocketImpl = globalThis.WebSocket,
    nowMs = () => Date.now(),
    nowIso = () => new Date().toISOString(),
    sleep = undefined,
    sshPort = 22,
  },
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        name: { type: "string" },
        account: { type: "string" },
        gpu: { type: "string" },
        "high-ram": { type: "boolean", default: false },
        new: { type: "boolean", default: false },
        browser: { type: "boolean", default: false },
        keep: { type: "boolean", default: false },
        "no-tailscale": { type: "boolean", default: false },
        timeout: { type: "string", default: "600" },
        "no-open": { type: "boolean", default: false },
        "system-browser": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const opts = parsed.values;
  const timeoutSeconds = Number.parseInt(opts.timeout ?? "600", 10);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new CliError(`invalid --timeout value: ${opts.timeout}`);
  }

  const config = readConfig(homeDir);
  const policy = resolveAgentPolicy(config);
  const paths = getColabPaths(homeDir);
  const account = resolveAccount(config, opts.account);

  const requestedGpuRaw = opts.gpu ? String(opts.gpu).trim().toUpperCase() : null;
  const selectedGpu =
    !requestedGpuRaw || requestedGpuRaw === "AUTO"
      ? policy.allowedGpus.includes("T4")
        ? "T4"
        : policy.allowedGpus[0] || "T4"
      : requestedGpuRaw;

  if (!policy.allowedGpus.includes(selectedGpu)) {
    const errMsg = `GPU '${selectedGpu}' is disabled by user policy in Orca Colab settings. Allowed GPUs: ${policy.allowedGpus.join(", ")}`;
    throw new CliError(errMsg, {
      exitCode: EXIT_ERROR,
      payload: {
        ok: false,
        error: errMsg,
        allowedGpus: policy.allowedGpus,
        step: "policy",
      },
    });
  }

  const activeAccountSessions = listSessions(homeDir).filter(
    (s) => s?.state !== "zombie" && (s?.account || "default") === account.label,
  );
  if (
    opts.new &&
    activeAccountSessions.length >= policy.maxConcurrentSessions
  ) {
    const errMsg = `Max concurrent sessions (${policy.maxConcurrentSessions}) reached by user policy.`;
    throw new CliError(errMsg, {
      exitCode: EXIT_ERROR,
      payload: {
        ok: false,
        error: errMsg,
        maxConcurrentSessions: policy.maxConcurrentSessions,
        step: "policy",
      },
    });
  }
  const tailscaleConfigured =
    isValidAuthKey(config?.authKey, config?.loginServer) &&
    existsSync(paths.privateKeyPath) &&
    existsSync(paths.publicKeyPath) &&
    !opts["no-tailscale"];

  let accessToken = null;
  if (!opts.browser) {
    try {
      accessToken = await getValidAccessToken({
        account: account.label,
        homeDir,
        fetchImpl,
      });
    } catch {
      accessToken = null;
    }
  }

  if (!tailscaleConfigured && !accessToken) {
    throw new CliError(
      "orca-colab is not configured; run 'orca-colab setup' first (or sign in with 'orca-colab auth login')",
      {
        exitCode: EXIT_ERROR,
        payload: {
          ok: false,
          error: "orca-colab is not configured; run 'orca-colab setup' first",
          step: "prerequisites",
        },
      },
    );
  }

  if (signal?.aborted) {
    throw new CliError("aborted before starting session", {
      exitCode: EXIT_ABORTED,
      payload: {
        ok: false,
        error: "aborted before starting session",
        step: "init",
      },
    });
  }

  // Fast path: Direct Colab API without Tailscale (when Google OAuth is active and Tailscale is not configured)
  if (accessToken && !tailscaleConfigured) {
    const gpuLabel = selectedGpu;
    const lockPath = path.join(paths.baseDir, "assign.lock");
    mkdirSync(paths.baseDir, { recursive: true, mode: 0o700 });
    const lockDeadline = Date.now() + 90_000;
    while (existsSync(lockPath) && Date.now() < lockDeadline) {
      try {
        const lockObj = JSON.parse(readFileSync(lockPath, "utf8"));
        const ageMs = Date.now() - (lockObj.ts || 0);
        let alive = false;
        try {
          process.kill(lockObj.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (!alive || ageMs > 90_000) {
          rmSync(lockPath, { force: true });
          break;
        }
      } catch {
        rmSync(lockPath, { force: true });
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, ts: Date.now() }),
        { mode: 0o600 },
      );
    } catch {
      // Proceed if lock write fails.
    }

    try {
      const currentActiveSessions = listSessions(homeDir).filter(
        (s) => s?.state !== "zombie" && (s?.account || "default") === account.label,
      );
      if (
        opts.new &&
        currentActiveSessions.length >= policy.maxConcurrentSessions
      ) {
        const errMsg = `Max concurrent sessions (${policy.maxConcurrentSessions}) reached by user policy.`;
        throw new CliError(errMsg, {
          exitCode: EXIT_ERROR,
          payload: {
            ok: false,
            error: errMsg,
            maxConcurrentSessions: policy.maxConcurrentSessions,
            step: "policy",
          },
        });
      }

      const excludeRuntimeIds = opts.new
        ? currentActiveSessions
            .filter((s) => s?.colabRuntime?.id)
            .map((s) => s.colabRuntime.id)
        : [];
      log(
        `Assigning Colab ${gpuLabel} runtime via Direct API for account '${account.label}' (Tailscale-free mode)...`,
        stderr,
      );
      const colabRuntime = await assignRuntimeFn({
        accessToken,
        gpu: gpuLabel,
        highRam: Boolean(opts["high-ram"]),
        reuseExisting: true,
        excludeRuntimeIds,
        onProgress: (msg) => log(msg, stderr),
        fetchImpl,
        signal,
      });
      log(
        `Assigned runtime ${colabRuntime.id}; querying GPU over /colab/tty...`,
        stderr,
      );
      const gpu = await queryGpuTtyFn({
        baseUrl: colabRuntime.baseUrl,
        proxyToken: colabRuntime.token,
        WebSocketImpl,
        signal,
      });
      const effectiveGpu =
        gpu?.name && gpu.name !== "Colab Runtime"
          ? gpu
          : {
              name: gpuLabel === "CPU" ? "Colab CPU" : `NVIDIA ${gpuLabel}`,
              memoryTotalMiB:
                gpuLabel === "T4"
                  ? 15360
                  : gpuLabel === "L4"
                    ? 23034
                    : gpuLabel === "A100"
                      ? 40960
                      : null,
              driverVersion: null,
            };
      const { rateKey, cuPerHour } = resolveGpuRate(effectiveGpu.name, homeDir);
      const createdAt = nowIso();
      const rawSuffix =
        opts.name ||
        String(colabRuntime.id || "")
          .replace(/[^a-z0-9]/gi, "")
          .slice(-6)
          .toLowerCase() ||
        "direct";
      const sessionName = rawSuffix.startsWith("orca-colab-")
        ? rawSuffix
        : `orca-colab-${rawSuffix}`;

      const sessionRecord = {
        name: sessionName,
        account: account.label,
        hostname: sessionName,
        ip: null,
        transport: "colab-tty",
        gpu: effectiveGpu,
        rateKey,
        cuPerHour,
        createdAt,
        lastActivityAt: createdAt,
        activePids: [],
        keep: Boolean(opts.keep),
        state: "active",
        remoteRoot: null,
        forwards: [],
        colabRuntime: {
          id: colabRuntime.id,
          endpoint: colabRuntime.endpoint,
          baseUrl: colabRuntime.baseUrl,
          token: colabRuntime.token,
          tokenExpiry: colabRuntime.tokenExpiry,
        },
      };

      const session = writeSession(sessionRecord, homeDir);
      if (onSessionStart) {
        await onSessionStart(session, homeDir);
      }

      log(
        `Session ${session.name} ready via Direct API (${session.gpu.name}, ~${session.cuPerHour} CU/h).`,
        stderr,
      );

      if (json) {
        const publicSession = {
          ...session,
          estimatedCuPerHour: session.cuPerHour,
        };
        if (publicSession.colabRuntime) {
          const { token: _omitToken, ...safeRuntime } = publicSession.colabRuntime;
          publicSession.colabRuntime = safeRuntime;
        }
        writeJson(publicSession, stdout);
      }

      return EXIT_OK;
    } finally {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Ignore lock cleanup error.
      }
    }
  }

  const getStatus =
    fetchTailscaleStatus ?? (() => getTailscaleStatus({ env }));
  const initialStatus = await getStatus();
  if (!initialStatus?.found || !initialStatus?.loggedIn) {
    throw new CliError(
      `Tailscale is not running or signed in (state: ${initialStatus?.backendState ?? "NotInstalled"})`,
      {
        exitCode: EXIT_ERROR,
        payload: {
          ok: false,
          error: `Tailscale is not running or signed in (state: ${initialStatus?.backendState ?? "NotInstalled"})`,
          step: "prerequisites",
        },
      },
    );
  }

  const deadlineMs = nowMs() + timeoutSeconds * 1000;
  const existingSessions = listSessions(homeDir).filter((s) => s?.state !== "zombie");
  const trackedHosts = new Set(existingSessions.map((s) => s.hostname || s.name));
  const baselinePeers = fetchTailscaleStatus
    ? snapshotOnlinePeers(initialStatus.peers ?? [])
    : snapshotOnlinePeers(
        (initialStatus.peers ?? []).filter((p) => trackedHosts.has(p.hostName)),
      );
  const publicKey = readFileSync(paths.publicKeyPath, "utf8").trim();

  const alreadyOnlinePeer = !fetchTailscaleStatus
    ? findNewColabPeer(initialStatus.peers ?? [], baselinePeers, opts.name ?? null)
    : null;

  let colabRuntime = null;
  let bootstrappedPeer = null;
  let usedDirectApi = false;

  if (!alreadyOnlinePeer && !opts.browser && accessToken) {
    try {
      const gpuLabel = String(opts.gpu || "T4").toUpperCase();
      log(
        `Assigning Colab ${gpuLabel} runtime via Direct API for account '${account.label}' (no browser required)...`,
        stderr,
      );
      colabRuntime = await assignRuntimeFn({
        accessToken,
        gpu: gpuLabel,
        highRam: Boolean(opts["high-ram"]),
        fetchImpl,
        signal,
      });
      log(
        `Assigned runtime ${colabRuntime.id}; bootstrapping Tailscale + sshd over /colab/tty...`,
        stderr,
      );
      const ttyResult = await bootstrapTtyFn({
        baseUrl: colabRuntime.baseUrl,
        proxyToken: colabRuntime.token,
        authKey: config.authKey,
        sshPublicKey: publicKey,
        loginServer: config.loginServer ?? "",
        hostnameSuffix: opts.name ?? "",
        WebSocketImpl,
        signal,
      });
      usedDirectApi = true;
      if (ttyResult?.hostname && ttyResult?.ip) {
        bootstrappedPeer = {
          hostName: ttyResult.hostname,
          ipv4: ttyResult.ip,
        };
      }
    } catch (apiErr) {
      const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      log(
        `Direct API provisioning failed (${msg}); falling back to browser notebook flow...`,
        stderr,
      );
    }
  }

  const orcaBin = !fetchTailscaleStatus && !usedDirectApi ? locateOrcaBinary(env) : null;
  const systemBrowserApp =
    !fetchTailscaleStatus && !usedDirectApi && orcaBin
      ? detectRunningSystemBrowser({ orcaBin, env })
      : null;
  const useSystemBrowser = Boolean(opts["system-browser"] || systemBrowserApp);

  if (!alreadyOnlinePeer && !usedDirectApi) {
    const pasteLine = config.loginServer
      ? `${config.authKey} ${config.loginServer} ${publicKey}`
      : `${config.authKey} ${publicKey}`;
    const clip = copyClipboard(pasteLine, { env });
    const hasPersonalDriveCopy = Boolean(
      account.notebookUrl &&
        account.notebookUrl !== BOOTSTRAP_NOTEBOOK_COLAB_URL &&
        !account.notebookUrl.includes("colab.research.google.com/github/"),
    );

    if (hasPersonalDriveCopy) {
      if (!opts["no-open"]) {
        openBrowser(account.notebookUrl, {
          env,
          systemBrowser: useSystemBrowser,
        });
      }
      log(
        `Opened notebook for account '${account.label}'. Choose a GPU runtime if needed and press Run.`,
        stderr,
      );
    } else {
      if (!opts["no-open"]) {
        openBrowser(BOOTSTRAP_NOTEBOOK_COLAB_URL, {
          env,
          systemBrowser: useSystemBrowser,
        });
      }
      if (clip.copied) {
        log(
          config.loginServer
            ? "Opened bootstrap notebook and copied '<authkey> <loginServer> <pubkey>' to clipboard for the PASTE field. Choose a GPU runtime and press Run."
            : "Opened bootstrap notebook and copied '<authkey> <pubkey>' to clipboard for the PASTE field. Choose a GPU runtime and press Run.",
          stderr,
        );
      } else {
        log(
          "Opened bootstrap notebook (clipboard unavailable; fill the form cell using ~/.orca-colab/config.json and ~/.orca-colab/id_ed25519.pub).",
          stderr,
        );
      }
    }
  }

  let autoState = { filled: false, clickedRun: false, clickedConfirm: false, done: false };
  const pollStatusWithAutomation = async () => {
    if (!alreadyOnlinePeer && !usedDirectApi && systemBrowserApp && !autoState.done) {
      try {
        const next = stepSystemBrowserColab({
          orcaBin,
          appName: systemBrowserApp,
          authKey: config.authKey,
          publicKey,
          loginServer: config.loginServer ?? "",
          hostSuffix: opts.name ?? "",
          state: autoState,
          env,
        });
        if (next.status === "filled-and-clicked-run" && !autoState.filled) {
          log(`Auto-filled credentials and clicked Run in ${systemBrowserApp}.`, stderr);
        } else if (next.status === "clicked-confirm" && !autoState.clickedConfirm) {
          log(`Confirmed 'Run anyway' dialog in ${systemBrowserApp}.`, stderr);
        }
        autoState = next;
      } catch {
        // Non-fatal: manual Run in the browser still works.
      }
    }
    return getStatus();
  };

  log("Waiting for a new online orca-colab-* peer on your tailnet...", stderr);
  const peer =
    alreadyOnlinePeer ??
    bootstrappedPeer ??
    (await waitForColabPeer({
      fetchStatus: pollStatusWithAutomation,
      baselinePeers,
      expectedName: opts.name ?? null,
      deadlineMs,
      signal,
      now: nowMs,
      ...(sleep ? { sleep } : {}),
    }));

  log(
    `Discovered peer ${peer.hostName} (${peer.ipv4}); probing SSH banner...`,
    stderr,
  );
  const probeBanner = probeSshBanner ?? waitForSshBanner;
  await probeBanner({
    host: peer.ipv4,
    port: sshPort,
    deadlineMs,
    signal,
    now: nowMs,
    ...(sleep ? { sleep } : {}),
  });

  log(`SSH ready on ${peer.ipv4}; querying GPU...`, stderr);
  const gpu = queryRemoteGpu({
    ip: peer.ipv4,
    homeDir,
    runSsh,
  });
  const { rateKey, cuPerHour } = resolveGpuRate(gpu.name, homeDir);
  const createdAt = nowIso();

  const sessionRecord = {
    name: peer.hostName,
    account: account.label,
    hostname: peer.hostName,
    ip: peer.ipv4,
    gpu,
    rateKey,
    cuPerHour,
    createdAt,
    lastActivityAt: createdAt,
    activePids: [],
    keep: Boolean(opts.keep),
    state: "active",
    remoteRoot: null,
    forwards: [],
  };
  if (colabRuntime) {
    sessionRecord.colabRuntime = {
      id: colabRuntime.id,
      endpoint: colabRuntime.endpoint,
      baseUrl: colabRuntime.baseUrl,
      token: colabRuntime.token,
      tokenExpiry: colabRuntime.tokenExpiry,
    };
  }

  const session = writeSession(sessionRecord, homeDir);

  if (onSessionStart) {
    await onSessionStart(session, homeDir);
  }

  log(
    `Session ${session.name} ready (${session.gpu.name}, ~${session.cuPerHour} CU/h).`,
    stderr,
  );

  if (json) {
    const publicSession = { ...session, estimatedCuPerHour: session.cuPerHour };
    if (publicSession.colabRuntime) {
      const { token: _omitToken, ...safeRuntime } = publicSession.colabRuntime;
      publicSession.colabRuntime = safeRuntime;
    }
    writeJson(publicSession, stdout);
  }

  return EXIT_OK;
}
