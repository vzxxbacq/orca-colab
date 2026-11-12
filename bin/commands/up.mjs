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
import {
  assignRuntime as defaultAssignRuntime,
  getConsumptionUserInfo as defaultGetConsumptionUserInfo,
  queryGpuOverTty as defaultQueryGpuOverTty,
} from "../lib/colab-api-client.mjs";
import {
  getColabPaths,
  readConfig,
  resolveAccount,
  resolveAgentPolicy,
} from "../lib/colab-home.mjs";
import {
  getValidAccessToken,
  listOAuthAccounts,
  readOAuthAccountStatus,
  resolveOAuthAccountKey,
} from "../lib/colab-oauth.mjs";
import {
  recordCalibrateEvent,
  recordSessionEndEvent,
  recordSessionStartEvent,
  resolveDeadSessionEndIso,
} from "../lib/credit-ledger.mjs";
import {
  resolveGpuRate as resolveRateFromTable,
  setRateOverride,
} from "../lib/rate-table.mjs";
import {
  deleteSession,
  listSessions,
  readSession,
  writeSession,
} from "../lib/session-store.mjs";

export async function run(
  argv,
  {
    json,
    stdout,
    stderr,
    env,
    homeDir,
    signal = null,
    resolveGpuRate = resolveRateFromTable,
    onSessionStart = recordSessionStartEvent,
    onSessionEnd = recordSessionEndEvent,
    assignRuntimeFn = defaultAssignRuntime,
    getConsumptionUserInfoFn = null,
    queryGpuTtyFn = defaultQueryGpuOverTty,
    fetchImpl = fetch,
    WebSocketImpl = globalThis.WebSocket,
    nowMs = () => Date.now(),
    nowIso = () => new Date().toISOString(),
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
        keep: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const opts = parsed.values;

  const config = readConfig(homeDir);
  const policy = resolveAgentPolicy(config);
  const paths = getColabPaths(homeDir);
  const allNonZombieSessions = listSessions(homeDir).filter(
    (s) => s?.state !== "zombie",
  );
  const oauthAccounts = listOAuthAccounts(homeDir);
  const explicitAccount =
    opts.account && opts.account !== "auto"
      ? resolveOAuthAccountKey(opts.account, null, homeDir)
      : null;

  let account = resolveAccount(config, explicitAccount || undefined);
  if (!explicitAccount && oauthAccounts.length > 0) {
    const defaultAuth = readOAuthAccountStatus(account.label, homeDir);
    const countFor = (label) =>
      allNonZombieSessions.filter((s) => (s?.account || "default") === label)
        .length;

    const candidates = [
      ...(defaultAuth.authenticated ? [defaultAuth.account] : []),
      ...oauthAccounts
        .map((a) => a.account)
        .filter((a) => a !== defaultAuth.account),
    ];

    if (opts.new) {
      const available = candidates.find(
        (label) => countFor(label) < policy.maxConcurrentSessions,
      );
      if (available) {
        account = resolveAccount(config, available);
      } else if (candidates[0]) {
        account = resolveAccount(config, candidates[0]);
      }
    } else if (!defaultAuth.authenticated && candidates[0]) {
      account = resolveAccount(config, candidates[0]);
    }
  }

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
  let accessToken = null;
  try {
    accessToken = await getValidAccessToken({
      account: account.label,
      homeDir,
      fetchImpl,
    });
  } catch {
    accessToken = null;
  }

  if (!accessToken) {
    const errMsg = `Not signed in to Google for account '${account.label}'; run 'orca-colab auth login' (tick the Colab permission).`;
    throw new CliError(errMsg, {
      exitCode: EXIT_ERROR,
      payload: { ok: false, error: errMsg, step: "prerequisites" },
    });
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

  const gpuLabel = selectedGpu;
  const lockPath = path.join(paths.baseDir, "assign.lock");
  mkdirSync(paths.baseDir, { recursive: true, mode: 0o700 });
  if (existsSync(lockPath)) {
    let activeLock = null;
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
      if (alive && ageMs < 90_000) {
        activeLock = {
          pid: lockObj.pid,
          gpu: lockObj.gpu || null,
          elapsedSeconds: Math.max(1, Math.round(ageMs / 1000)),
        };
      } else {
        rmSync(lockPath, { force: true });
      }
    } catch {
      rmSync(lockPath, { force: true });
    }

    if (activeLock) {
      const errMsg = `Another Colab runtime provisioning is currently in progress (PID ${activeLock.pid}, started ${activeLock.elapsedSeconds}s ago). Wait ~15 seconds and retry 'orca-colab up'.`;
      throw new CliError(errMsg, {
        exitCode: EXIT_ERROR,
        payload: {
          ok: false,
          code: "PROVISIONING_IN_PROGRESS",
          retryAfterSeconds: 15,
          lockedByPid: activeLock.pid,
          elapsedSeconds: activeLock.elapsedSeconds,
          error: errMsg,
          step: "assign_lock",
        },
      });
    }
  }
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, gpu: gpuLabel, ts: Date.now() }),
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
      `Assigning Colab ${gpuLabel} runtime via Direct API for account '${account.label}'...`,
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
    let { rateKey, cuPerHour } = resolveGpuRate(effectiveGpu.name, homeDir);
    const nowIsoVal = nowIso();
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

    const fetchCcuInfo =
      getConsumptionUserInfoFn ??
      (assignRuntimeFn === defaultAssignRuntime
        ? defaultGetConsumptionUserInfo
        : null);
    let syncedCcu = null;
    if (fetchCcuInfo && accessToken) {
      try {
        syncedCcu = await fetchCcuInfo({ accessToken, fetchImpl, signal });
        if (
          typeof syncedCcu?.consumptionRateHourly === "number" &&
          Number.isFinite(syncedCcu.consumptionRateHourly) &&
          syncedCcu.consumptionRateHourly > 0 &&
          (syncedCcu.assignmentsCount ?? 1) <= 1
        ) {
          cuPerHour =
            Math.round(
              (syncedCcu.consumptionRateHourly + Number.EPSILON) * 100,
            ) / 100;
          if (rateKey && rateKey !== "unknown") {
            setRateOverride(rateKey, cuPerHour, homeDir);
          }
        }
      } catch {
        // Best-effort CCU rate & balance sync.
      }
    }

    const existingSameName = readSession(sessionName, homeDir);
    const isSameRuntime = Boolean(
      existingSameName &&
        existingSameName.state !== "zombie" &&
        existingSameName.colabRuntime?.id &&
        existingSameName.colabRuntime.id === colabRuntime.id,
    );

    if (existingSameName && existingSameName.state !== "zombie" && !isSameRuntime) {
      if (onSessionEnd) {
        await onSessionEnd(existingSameName, {
          cause: "colab-died",
          endedAt: resolveDeadSessionEndIso(existingSameName, nowMs()),
          homeDir,
        });
      }
    }

    if (!opts.new && assignRuntimeFn === defaultAssignRuntime) {
      const otherStale = currentActiveSessions.filter(
        (s) =>
          s.name !== sessionName &&
          s.colabRuntime?.id &&
          s.colabRuntime.id !== colabRuntime.id &&
          (s.rateKey === rateKey || (syncedCcu?.assignmentsCount ?? 2) <= 1),
      );
      for (const stale of otherStale) {
        deleteSession(stale.name, homeDir);
        if (onSessionEnd) {
          await onSessionEnd(stale, {
            cause: "colab-died",
            endedAt: resolveDeadSessionEndIso(stale, nowMs()),
            homeDir,
          });
        }
      }
    }

    const createdAt = isSameRuntime ? existingSameName.createdAt : nowIsoVal;

    const sessionRecord = {
      name: sessionName,
      account: account.label,
      hostname: sessionName,
      transport: "colab-tty",
      gpu: effectiveGpu,
      rateKey,
      cuPerHour,
      createdAt,
      lastActivityAt: nowIsoVal,
      activePids: isSameRuntime ? existingSameName.activePids ?? [] : [],
      keep: Boolean(opts.keep || (isSameRuntime && existingSameName.keep)),
      state: "active",
      remoteRoot: isSameRuntime ? existingSameName.remoteRoot ?? null : null,
      colabRuntime: {
        id: colabRuntime.id,
        endpoint: colabRuntime.endpoint,
        baseUrl: colabRuntime.baseUrl,
        token: colabRuntime.token,
        tokenExpiry: colabRuntime.tokenExpiry,
      },
    };

    const session = writeSession(sessionRecord, homeDir);
    if (onSessionStart && !isSameRuntime) {
      await onSessionStart(session, homeDir);
    }
    if (syncedCcu && typeof syncedCcu.paidComputeUnitsBalance === "number") {
      recordCalibrateEvent(
        {
          account: account.label,
          balanceCu: syncedCcu.paidComputeUnitsBalance,
          consumptionRateHourly: syncedCcu.consumptionRateHourly,
          assignmentsCount: syncedCcu.assignmentsCount,
          source: "colab-api",
          at: nowIsoVal,
        },
        homeDir,
      );
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
