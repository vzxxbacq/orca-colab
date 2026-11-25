import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncCreditsFromColabApi } from "../commands/credits.mjs";
import { discoverAccountRuntimes } from "./account-runtimes.mjs";
import { getRuntimeResources } from "./colab-api-client.mjs";
import {
  getColabPaths,
  listKnownAccountLabels,
  readConfig,
  resolveAccount,
  resolveAgentPolicy,
} from "./colab-home.mjs";
import { listOAuthAccounts, listReauthAccounts, readOAuthAccountStatus } from "./colab-oauth.mjs";
import { listRecentSessionEnds, projectAccountCredits, readLedgerEvents } from "./credit-ledger.mjs";
import { runDoctor } from "./doctor.mjs";
import { evaluateSessionIdleState } from "./idle-watchdog.mjs";
import { readRateTable } from "./rate-table.mjs";
import { liveForwards } from "./port-forward.mjs";
import { createRuntimeChannel } from "./runtime-channel.mjs";
import { presenceOf } from "./runtime-presence.mjs";
import { failJobsOfReleasedRuntimes, mirrorRuntimeTasks, mirrorTaskLog } from "./runtime-jobs.mjs";
import { machineName, readRuntimeUsage } from "./runtime-records.mjs";
import { listSessions } from "./session-store.mjs";
import { listTasks, readTaskLog } from "./task-store.mjs";

export function pickActiveTask(tasks, selectedTaskId = null) {
  return (
    (selectedTaskId && tasks.find((t) => t.id === selectedTaskId)) ||
    tasks.find((t) => t.status === "running") ||
    tasks[0] ||
    null
  );
}

export function readProvisioningLock(homeDir = os.homedir()) {
  const lockFile = path.join(getColabPaths(homeDir).baseDir, "assign.lock");
  if (!existsSync(lockFile)) {
    return null;
  }
  try {
    const lockObj = JSON.parse(readFileSync(lockFile, "utf8"));
    const ageMs = Date.now() - (lockObj.ts || 0);
    process.kill(lockObj.pid, 0);
    if (ageMs < 90_000) {
      return {
        active: true,
        message: `Agent (PID ${lockObj.pid}) is provisioning Colab ${lockObj.gpu || "GPU"} runtime (${Math.max(1, Math.round(ageMs / 1000))}s)...`,
        error: null,
      };
    }
  } catch {
    // Stale or finished lock.
  }
  return null;
}

// Holds the per-session caches (GPU samples, last live metrics, doctor) that make a snapshot cheap to
// rebuild every poll. One instance per ~/.orca-colab home.
export class DashboardSnapshotBuilder {
  constructor({ homeDir = os.homedir(), env = process.env, origin = null, fetchImpl = fetch } = {}) {
    this.homeDir = homeDir;
    this.env = env;
    this.origin = origin;
    this.fetchImpl = fetchImpl;
    this.usageBySession = new Map();
    this.logCopyInFlight = new Set();
    this.lastRuntimeSyncAt = 0;
    this.lastDiscoveryAt = 0;
    this.runtimeSyncInFlight = null;
    this.lastRuntimeSyncError = null;
    this.lastDiscoveryError = null;
    this.gpuUtilSamplesBySession = new Map();
    this.liveMetricsBySession = new Map();
    this.lastCcuSyncAtByAccount = new Map();
    this.inFlightCcuSyncByAccount = new Map();
    this.liveCcuEventByAccount = new Map();
    this.ccuSyncErrorByAccount = new Map();
    this.cachedDoctor = null;
    this.lastDoctorAt = 0;
  }

  invalidateDoctor() {
    this.cachedDoctor = null;
  }

  async syncAccountCcu(account) {
    if (this.inFlightCcuSyncByAccount.has(account)) {
      return this.inFlightCcuSyncByAccount.get(account);
    }
    const promise = (async () => {
      try {
        this.lastCcuSyncAtByAccount.set(account, Date.now());
        const synced = await syncCreditsFromColabApi({
          account,
          homeDir: this.homeDir,
          fetchImpl: this.fetchImpl,
          forceRecord: false,
        });
        if (synced?.event) {
          this.liveCcuEventByAccount.set(account, synced.event);
        }
        this.ccuSyncErrorByAccount.delete(account);
      } catch (err) {
        // The poll goes on, and the snapshot says why the balance is stale. A sign-in Google refused is
        // on disk by now, so the doctor result cached before it is out of date.
        this.ccuSyncErrorByAccount.set(account, err?.message || String(err));
        if (err?.code === "OAUTH_REAUTH_REQUIRED") this.invalidateDoctor();
      } finally {
        this.inFlightCcuSyncByAccount.delete(account);
      }
    })();
    this.inFlightCcuSyncByAccount.set(account, promise);
    return promise;
  }

  // Brings this machine's files in line with the account: runtimes at Colab (also ones other machines
  // started), the jobs on each runtime, and who is using it. Everything else in a snapshot is then
  // read from ~/.orca-colab as before.
  async syncFromRuntimes({ maxAgeMs = 10_000 } = {}) {
    if (this.runtimeSyncInFlight) {
      return this.runtimeSyncInFlight;
    }
    if (Date.now() - this.lastRuntimeSyncAt < maxAgeMs) {
      return null;
    }
    const { homeDir, fetchImpl } = this;
    this.runtimeSyncInFlight = (async () => {
      try {
        // Colab's list changes rarely; the runtimes themselves are asked on every sync.
        if (Date.now() - this.lastDiscoveryAt >= Math.min(maxAgeMs * 3, 60_000)) {
          const changes = await discoverAccountRuntimes({ homeDir, env: this.env, fetchImpl });
          this.lastDiscoveryError = changes?.unreachable ?? changes?.reauthRequired ?? null;
          if (changes?.reauthRequired) this.invalidateDoctor();
          this.lastDiscoveryAt = Date.now();
        }
        const live = listSessions(homeDir).filter(
          (s) => s.state !== "zombie" && s.colabRuntime?.baseUrl && s.colabRuntime?.token,
        );
        await Promise.all(
          live.map(async (session) => {
            const channel = createRuntimeChannel({ sessionName: session.name, homeDir, fetchImpl });
            await mirrorRuntimeTasks({ session, homeDir, fetchImpl, channel }).catch(() => {});
            const usage = await readRuntimeUsage(channel).catch(() => null);
            if (usage) this.usageBySession.set(session.name, { ...usage, readAt: Date.now() });
          }),
        );
        for (const name of this.usageBySession.keys()) {
          if (!live.some((s) => s.name === name)) this.usageBySession.delete(name);
        }
        failJobsOfReleasedRuntimes(homeDir);
        this.lastRuntimeSyncError = this.lastDiscoveryError;
      } catch (err) {
        this.lastRuntimeSyncError = err?.message || String(err);
      } finally {
        this.lastRuntimeSyncAt = Date.now();
        this.runtimeSyncInFlight = null;
      }
    })();
    return this.runtimeSyncInFlight;
  }

  copyTaskLog(task) {
    if (this.logCopyInFlight.has(task.id)) return;
    this.logCopyInFlight.add(task.id);
    void mirrorTaskLog({ task, homeDir: this.homeDir, fetchImpl: this.fetchImpl })
      .catch(() => {})
      .finally(() => this.logCopyInFlight.delete(task.id));
  }

  // What the runtime's records say now, minus this machine's own command (the reader is not a user).
  runtimeUsage(sessionName) {
    const usage = this.usageBySession.get(sessionName);
    if (!usage) return null;
    return {
      ...usage,
      idleMs: typeof usage.idleMs === "number" ? usage.idleMs + (Date.now() - usage.readAt) : null,
      busyBy: usage.busyBy.filter((u) => u.machine !== machineName(this.env)),
    };
  }

  recordGpuSample(sessionName, percent) {
    const prev = this.gpuUtilSamplesBySession.get(sessionName) || [];
    this.gpuUtilSamplesBySession.set(sessionName, [...prev.slice(-5), percent]);
  }

  doctor() {
    if (!this.cachedDoctor || Date.now() - this.lastDoctorAt > 30_000) {
      this.cachedDoctor = runDoctor({ homeDir: this.homeDir, env: this.env });
      this.lastDoctorAt = Date.now();
    }
    return this.cachedDoctor;
  }

  async build({
    includeLiveMetrics = false,
    selectedTaskId = null,
    provisioningState = null,
    tailLines = 250,
    logMaxBytes = 65536,
  } = {}) {
    const { homeDir } = this;
    const config = readConfig(homeDir);
    const configuredDefault = resolveAccount(config).label;
    const accounts = listKnownAccountLabels(homeDir, config);
    const authByAccount = {};
    for (const acc of accounts) {
      authByAccount[acc] = readOAuthAccountStatus(acc, homeDir);
      if (authByAccount[acc]?.authenticated) {
        const lastSync = this.lastCcuSyncAtByAccount.get(acc) || 0;
        const ageMs = Date.now() - lastSync;
        if (includeLiveMetrics && ageMs > 5_000) {
          await this.syncAccountCcu(acc);
          // The sync is what finds out that Google refuses this sign-in.
          authByAccount[acc] = readOAuthAccountStatus(acc, homeDir);
        } else if (ageMs > 30_000) {
          void this.syncAccountCcu(acc);
        }
      } else {
        this.ccuSyncErrorByAccount.delete(acc);
      }
    }
    // Read after the syncs above, so an account found refused in this build is not listed as connected.
    const oauthAccounts = listOAuthAccounts(homeDir);
    const reauthAccounts = listReauthAccounts(homeDir);
    const defaultAccount =
      oauthAccounts.some((a) => a.account === configuredDefault) || oauthAccounts.length === 0
        ? configuredDefault
        : oauthAccounts[0].account;

    const sessions = listSessions(homeDir);
    const tasks = listTasks(homeDir);
    const events = readLedgerEvents(homeDir);
    const rates = readRateTable(homeDir);

    const enrichedSessions = await Promise.all(
      sessions.map((s) => this.enrichSession(s, tasks, includeLiveMetrics)),
    );

    const creditsByAccount = {};
    for (const acc of accounts) {
      const liveEv = this.liveCcuEventByAccount.get(acc);
      const accEvents =
        liveEv && events.at(-1)?.at !== liveEv.at
          ? [...events, liveEv]
          : events;
      creditsByAccount[acc] = projectAccountCredits({
        events: accEvents,
        activeSessions: sessions,
        account: acc,
        nowMs: Date.now(),
      });
    }

    const activeTask = pickActiveTask(tasks, selectedTaskId);
    let activeTaskOutput = null;
    if (activeTask) {
      // A job followed by no process on this machine has its output on the runtime only. The copy runs
      // beside the snapshot, never inside it: a runtime that answers slowly must not hold the panel up.
      if (activeTask.runtimeBacked && !activeTask.logComplete) {
        this.copyTaskLog(activeTask);
      }
      const logSnap = readTaskLog(activeTask.id, homeDir, { tailLines, maxBytes: logMaxBytes });
      activeTaskOutput = {
        taskId: activeTask.id,
        status: activeTask.status,
        exitCode: activeTask.exitCode,
        output: logSnap.text,
        totalBytes: logSnap.totalBytes,
        truncated: logSnap.truncated,
      };
    }

    const effectiveProvisioning =
      provisioningState?.active
        ? provisioningState
        : readProvisioningLock(homeDir) || provisioningState || { active: false, message: null, error: null };

    return {
      origin: this.origin,
      machine: machineName(this.env),
      runtimeSync: { at: this.lastRuntimeSyncAt || null, error: this.lastRuntimeSyncError },
      creditsSync: {
        error: this.ccuSyncErrorByAccount.get(defaultAccount) ?? null,
        errorByAccount: Object.fromEntries(this.ccuSyncErrorByAccount),
      },
      defaultAccount,
      accounts,
      oauthAccounts,
      reauthAccounts,
      doctor: this.doctor(),
      policy: resolveAgentPolicy(config),
      provisioning: effectiveProvisioning,
      auth: authByAccount[defaultAccount] || { account: defaultAccount, authenticated: false },
      authByAccount,
      sessions: enrichedSessions,
      recentlyEnded: listRecentSessionEnds(homeDir),
      credits: creditsByAccount[defaultAccount],
      creditsByAccount,
      tasks,
      activeTaskOutput,
      rates,
    };
  }

  async enrichSession(s, tasks, includeLiveMetrics) {
    const { homeDir } = this;
    const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(s.createdAt)) / 1000));
    const sessionRunningTasks = tasks.filter(
      (t) => t.sessionName === s.name && t.status === "running",
    ).length;
    const usage = this.runtimeUsage(s.name);
    const idleInfo = evaluateSessionIdleState({
      session: s,
      gpuSamples: this.gpuUtilSamplesBySession.get(s.name) || [],
      runningTasksCount: sessionRunningTasks,
      nowMs: Date.now(),
      runtimeUsage: usage,
    });

    const reachable = s.state !== "zombie";
    let liveMetrics = this.liveMetricsBySession.get(s.name) || null;
    if (includeLiveMetrics && s.state !== "zombie") {
      if (s.colabRuntime?.baseUrl && s.colabRuntime?.token) {
        try {
          const resInfo = await getRuntimeResources({
            baseUrl: s.colabRuntime.baseUrl,
            proxyToken: s.colabRuntime.token,
            timeoutMs: 3500,
          });
          const g0 = Array.isArray(resInfo?.gpus) ? resInfo.gpus[0] : null;
          const toMiB = (b) => (typeof b === "number" ? Math.round(b / (1024 * 1024)) : null);
          const toGiB = (b) => Number((b / (1024 * 1024 * 1024)).toFixed(1));
          liveMetrics = {
            gpuUtilizationPercent:
              typeof g0?.gpuUtilization === "number" ? Math.round(g0.gpuUtilization * 100) : null,
            vramUsedMiB: toMiB(g0?.memoryUsedBytes),
            vramTotalMiB: toMiB(g0?.memoryTotalBytes) ?? s.gpu?.memoryTotalMiB ?? null,
            ramTotalGiB:
              typeof resInfo?.memory?.totalBytes === "number" ? toGiB(resInfo.memory.totalBytes) : null,
            ramUsedGiB:
              typeof resInfo?.memory?.totalBytes === "number" &&
              typeof resInfo?.memory?.freeBytes === "number"
                ? toGiB(resInfo.memory.totalBytes - resInfo.memory.freeBytes)
                : null,
          };
          this.liveMetricsBySession.set(s.name, liveMetrics);
        } catch {
          // Keep the last metrics; the next poll retries.
        }
      }
    }

    const safeRuntime = s.colabRuntime
      ? {
          id: s.colabRuntime.id,
          endpoint: s.colabRuntime.endpoint,
          baseUrl: s.colabRuntime.baseUrl,
          tokenExpiry: s.colabRuntime.tokenExpiry,
        }
      : null;

    return {
      ...s,
      colabRuntime: safeRuntime,
      forwards: liveForwards(s),
      presence: presenceOf(s),
      origin: s.origin ?? null,
      startedHere: !s.adopted,
      inUseBy: usage?.busyBy ?? [],
      reachable,
      ageSeconds,
      runningTasksCount: sessionRunningTasks,
      idleInfo,
      liveMetrics,
      costSoFarCu: Number(((ageSeconds / 3600) * (s.cuPerHour || 0)).toFixed(2)),
    };
  }
}
