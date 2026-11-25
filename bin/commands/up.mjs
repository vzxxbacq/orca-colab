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
} from "../lib/colab-home.mjs";
import {
  getValidAccessToken,
  listOAuthAccounts,
  OAUTH_REAUTH_REQUIRED,
  reauthErrorPayload,
  readOAuthAccountStatus,
  resolveOAuthAccountKey,
} from "../lib/colab-oauth.mjs";
import {
  estimateProjectMonthlyUse,
  projectAccountCredits,
  readLedgerEvents,
  recordCalibrateEvent,
  recordSessionEndEvent,
  recordSessionStartEvent,
  resolveDeadSessionEndIso,
} from "../lib/credit-ledger.mjs";
import { guardrailsForRecord, resolveGuardrails } from "../lib/project-guardrails.mjs";
import {
  resolveGpuRate as resolveRateFromTable,
  setRateOverride,
} from "../lib/rate-table.mjs";
import {
  describeOrigin,
  directRuntimeChannel,
  machineName,
  readRuntimeSessionRecord,
  sameMachine,
  writeRuntimeSessionRecord,
} from "../lib/runtime-records.mjs";
import {
  deleteSession,
  distinctRuntimeSessions,
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
    cwd = null,
    projectDir = cwd,
    homeDir,
    signal = null,
    openRuntimeChannel = null,
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
  // The project's .orca/colab.json, found from where the work is started, over this machine's config.
  const policy = resolveGuardrails({ cwd: projectDir || null, homeDir });
  const policyOrigin = policy.source === "project" ? `this project's guardrails (${policy.file})` : "user policy in Orca Colab settings";
  const startedFromProject = (s) => policy.source !== "project" || !policy.setByProject.includes("maxConcurrentSessions") || s?.project === policy.project;
  const paths = getColabPaths(homeDir);
  const allNonZombieSessions = distinctRuntimeSessions(listSessions(homeDir)).filter(
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
    const errMsg = `GPU '${selectedGpu}' is disabled by ${policyOrigin}. Allowed GPUs: ${policy.allowedGpus.join(", ")}`;
    throw new CliError(errMsg, {
      exitCode: EXIT_ERROR,
      payload: {
        ok: false,
        error: errMsg,
        allowedGpus: policy.allowedGpus,
        ...(policy.source === "project" ? { source: "project", file: policy.file } : {}),
        step: "policy",
      },
    });
  }

  const activeAccountSessions = distinctRuntimeSessions(listSessions(homeDir)).filter(
    (s) => s?.state !== "zombie" && (s?.account || "default") === account.label,
  );
  // A cap set by the project counts the runtimes started from that project; the machine's counts all.
  if (
    opts.new &&
    activeAccountSessions.filter(startedFromProject).length >= policy.maxConcurrentSessions
  ) {
    const errMsg = `Max concurrent sessions (${policy.maxConcurrentSessions}) reached by ${policyOrigin}.`;
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

  // The budget stops new spending only: attaching to a runtime that is already billing stays allowed.
  if (policy.monthlyBudgetCu && (opts.new || activeAccountSessions.length === 0)) {
    // The project's own budget, counted from what this machine's ledger holds for this project.
    const used = estimateProjectMonthlyUse({
      events: readLedgerEvents(homeDir),
      activeSessions: listSessions(homeDir),
      project: policy.project,
      nowMs: nowMs(),
    });
    if (used >= policy.monthlyBudgetCu) {
      const errMsg = `Monthly compute-unit budget reached for this project (${policy.file}): about ${used} of ${policy.monthlyBudgetCu} CU used this month by runtimes started from it on this machine (estimate). No new runtime was started.`;
      throw new CliError(errMsg, {
        exitCode: EXIT_ERROR,
        payload: {
          ok: false,
          code: "BUDGET_REACHED",
          error: errMsg,
          scope: "project",
          project: policy.project,
          file: policy.file,
          approximate: true,
          budgetCu: policy.monthlyBudgetCu,
          estimatedMonthlyUsedCu: used,
          estimatedBudgetUsedPercent: Math.round((used / policy.monthlyBudgetCu) * 100),
          hint: `Only the owner can raise this project's budget: monthlyBudgetCu in ${policy.file} (or the Guardrails view of the Colab GPU panel on the machine that has the project).`,
          step: "budget",
        },
      });
    }
  } else if (opts.new || activeAccountSessions.length === 0) {
    const credits = projectAccountCredits({
      events: readLedgerEvents(homeDir),
      activeSessions: listSessions(homeDir),
      account: account.label,
      nowMs: nowMs(),
    });
    if (credits.budgetCu > 0 && credits.estimatedMonthlyUsedCu >= credits.budgetCu) {
      const errMsg = `Monthly compute-unit budget reached for account '${account.label}': about ${credits.estimatedMonthlyUsedCu} of ${credits.budgetCu} CU used this month (estimate). No new runtime was started.`;
      throw new CliError(errMsg, {
        exitCode: EXIT_ERROR,
        payload: {
          ok: false,
          code: "BUDGET_REACHED",
          error: errMsg,
          account: account.label,
          approximate: true,
          budgetCu: credits.budgetCu,
          estimatedMonthlyUsedCu: credits.estimatedMonthlyUsedCu,
          estimatedBudgetUsedPercent: credits.estimatedBudgetUsedPercent,
          hint: "Only the owner can raise the monthly budget: under Guardrails & CU in the Colab GPU panel, or with 'orca-colab credits budget <cu>' (0 removes the limit).",
          step: "budget",
        },
      });
    }
  }

  let accessToken = null;
  try {
    accessToken = await getValidAccessToken({
      account: account.label,
      homeDir,
      fetchImpl,
    });
  } catch (err) {
    // Each failure keeps its own cause: a refused sign-in and an unreachable network are not "not signed in".
    if (err?.code === OAUTH_REAUTH_REQUIRED) {
      throw new CliError(err.message, {
        exitCode: EXIT_ERROR,
        payload: { ...reauthErrorPayload(err), step: "prerequisites" },
      });
    }
    if (err?.code === "NETWORK_UNREACHABLE") {
      throw err;
    }
    const errMsg = `Could not refresh the Google sign-in for account '${account.label}': ${err?.message || err}`;
    throw new CliError(errMsg, {
      exitCode: EXIT_ERROR,
      payload: { ok: false, error: errMsg, step: "prerequisites" },
    });
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
    const currentActiveSessions = distinctRuntimeSessions(listSessions(homeDir)).filter(
      (s) => s?.state !== "zombie" && (s?.account || "default") === account.label,
    );
    if (
      opts.new &&
      currentActiveSessions.filter(startedFromProject).length >= policy.maxConcurrentSessions
    ) {
      const errMsg = `Max concurrent sessions (${policy.maxConcurrentSessions}) reached by ${policyOrigin}.`;
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
      fetchImpl,
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
    // A reused runtime may have been started from another machine; its own record says by whom and
    // under which name, and that record is left as it is.
    const openChannel =
      openRuntimeChannel ?? (assignRuntimeFn === defaultAssignRuntime || fetchImpl !== fetch ? directRuntimeChannel : null);
    const runtimeChannel = openChannel
      ? openChannel({ baseUrl: colabRuntime.baseUrl, proxyToken: colabRuntime.token, fetchImpl })
      : null;
    const runtimeRecord = runtimeChannel ? await readRuntimeSessionRecord(runtimeChannel).catch(() => null) : null;
    const origin = runtimeRecord ? runtimeRecord.origin : describeOrigin({ env, cwd });
    const rawSuffix =
      opts.name ||
      runtimeRecord?.name ||
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

    const createdAt = isSameRuntime ? existingSameName.createdAt : runtimeRecord?.createdAt || nowIsoVal;

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
      keep: Boolean(opts.keep || (isSameRuntime && existingSameName.keep) || runtimeRecord?.keep),
      state: "active",
      ...(origin ? { origin } : {}),
      ...(runtimeRecord && !sameMachine(runtimeRecord.origin, machineName(env)) ? { adopted: true } : {}),
      // A reused runtime stays under the guardrails it was started with; a new one records these.
      project: runtimeRecord ? runtimeRecord.project : policy.project,
      guardrails: runtimeRecord
        ? runtimeRecord.guardrails
        : guardrailsForRecord(policy, {
            machineBudgetCu: projectAccountCredits({
              events: readLedgerEvents(homeDir),
              activeSessions: [],
              account: account.label,
              nowMs: nowMs(),
            }).budgetCu,
          }),
      remoteRoot: isSameRuntime ? existingSameName.remoteRoot ?? null : null,
      ...(isSameRuntime && existingSameName.forwards ? { forwards: existingSameName.forwards } : {}),
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
    if (runtimeChannel && (!runtimeRecord || runtimeRecord.name !== session.name || runtimeRecord.keep !== session.keep)) {
      try {
        await writeRuntimeSessionRecord(runtimeChannel, session, {
          email: readOAuthAccountStatus(account.label, homeDir).email || null,
        });
      } catch (err) {
        log(`warning: could not write the session record on the runtime (${err?.message || err}); other machines will show it as unknown origin.`, stderr);
      }
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
