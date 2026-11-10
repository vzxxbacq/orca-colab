import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRuntimeResources } from "./colab-api-client.mjs";
import {
  getColabPaths,
  listKnownAccountLabels,
  readConfig,
  resolveAccount,
  resolveAgentPolicy,
} from "./colab-home.mjs";
import { listOAuthAccounts, readOAuthAccountStatus } from "./colab-oauth.mjs";
import { projectAccountCredits, readLedgerEvents } from "./credit-ledger.mjs";
import { runDoctor } from "./doctor.mjs";
import { evaluateSessionIdleState } from "./idle-watchdog.mjs";
import { readRateTable } from "./rate-table.mjs";
import { listSessions } from "./session-store.mjs";
import { probeSshBannerOnce } from "./ssh-banner-probe.mjs";
import { execSshCapture } from "./ssh-exec.mjs";
import { listTasks, readTaskLog } from "./task-store.mjs";

export function queryLiveGpuMetricsViaSsh(ip, homeDir = os.homedir()) {
  try {
    const res = execSshCapture({
      ip,
      remoteCommand:
        "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits",
      homeDir,
      timeoutMs: 4000,
    });
    if (res.exitCode !== 0 || !res.stdout.trim()) {
      return null;
    }
    const parts = res.stdout
      .trim()
      .split("\n")[0]
      .split(",")
      .map((s) => Number(s.trim()));
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      return {
        gpuUtilizationPercent: parts[0],
        vramUsedMiB: parts[1],
        vramTotalMiB: parts[2],
      };
    }
  } catch {
    // Ignore transient SSH probe failure.
  }
  return null;
}

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
  constructor({ homeDir = os.homedir(), env = process.env, skillSync = null, origin = null } = {}) {
    this.homeDir = homeDir;
    this.env = env;
    this.skillSync = skillSync;
    this.origin = origin;
    this.gpuUtilSamplesBySession = new Map();
    this.liveMetricsBySession = new Map();
    this.cachedDoctor = null;
    this.lastDoctorAt = 0;
  }

  invalidateDoctor() {
    this.cachedDoctor = null;
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
    const oauthAccounts = listOAuthAccounts(homeDir);
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
    const authByAccount = {};
    for (const acc of accounts) {
      creditsByAccount[acc] = projectAccountCredits({
        events,
        activeSessions: sessions,
        account: acc,
        nowMs: Date.now(),
      });
      authByAccount[acc] = readOAuthAccountStatus(acc, homeDir);
    }

    const activeTask = pickActiveTask(tasks, selectedTaskId);
    let activeTaskOutput = null;
    if (activeTask) {
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
      defaultAccount,
      accounts,
      oauthAccounts,
      doctor: this.doctor(),
      policy: resolveAgentPolicy(config),
      skillSync: this.skillSync,
      provisioning: effectiveProvisioning,
      auth: authByAccount[defaultAccount] || { account: defaultAccount, authenticated: false },
      authByAccount,
      sessions: enrichedSessions,
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
    const idleInfo = evaluateSessionIdleState({
      session: s,
      gpuSamples: this.gpuUtilSamplesBySession.get(s.name) || [],
      runningTasksCount: sessionRunningTasks,
      nowMs: Date.now(),
    });

    let reachable = s.state !== "zombie";
    let liveMetrics = this.liveMetricsBySession.get(s.name) || null;
    if (includeLiveMetrics && s.state !== "zombie") {
      if (s.ip) {
        const probe = await probeSshBannerOnce({ host: s.ip, port: 22, timeoutMs: 2500 }).catch(
          () => ({ ok: false }),
        );
        reachable = Boolean(probe?.ok);
      }

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
          // Fall back to SSH nvidia-smi below when an IP is present.
        }
      }

      if (!liveMetrics && s.ip && reachable) {
        liveMetrics = queryLiveGpuMetricsViaSsh(s.ip, homeDir);
        if (liveMetrics) {
          this.liveMetricsBySession.set(s.name, liveMetrics);
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
      reachable,
      ageSeconds,
      runningTasksCount: sessionRunningTasks,
      idleInfo,
      liveMetrics,
      costSoFarCu: Number(((ageSeconds / 3600) * (s.cuPerHour || 0)).toFixed(2)),
    };
  }
}
