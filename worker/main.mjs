import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run as runCreditsCommand } from "../bin/commands/credits.mjs";
import { run as runDownCommand } from "../bin/commands/down.mjs";
import { stopTaskById, submitTask } from "../bin/commands/job.mjs";
import { run as runSetupCommand } from "../bin/commands/setup.mjs";
import { run as runUpCommand } from "../bin/commands/up.mjs";
import {
  getConsumptionUserInfo,
  getRuntime,
  getRuntimeResources,
} from "../bin/lib/colab-api-client.mjs";
import { locateOrcaBinary } from "../bin/lib/colab-browser-automation.mjs";
import {
  ensureColabHome,
  getColabPaths,
  readConfig,
  resolveAccount,
  resolveAgentPolicy,
  writeConfig,
} from "../bin/lib/colab-home.mjs";
import {
  getValidAccessToken,
  readOAuthAccountStatus,
  removeOAuthCredentials,
  runLoopbackOAuthFlow,
} from "../bin/lib/colab-oauth.mjs";
import {
  projectAccountCredits,
  readLedgerEvents,
  recordBudgetSetEvent,
  recordCalibrateEvent,
} from "../bin/lib/credit-ledger.mjs";
import { runDoctor } from "../bin/lib/doctor.mjs";
import {
  DEFAULT_AUTO_STOP_IDLE_MINUTES,
  evaluateBudgetAlert,
  evaluateSessionIdleState,
  GRACE_PERIOD_MINUTES,
} from "../bin/lib/idle-watchdog.mjs";
import { readRateTable } from "../bin/lib/rate-table.mjs";
import {
  listSessions,
  readSession,
  writeSession,
} from "../bin/lib/session-store.mjs";
import { probeSshBannerOnce } from "../bin/lib/ssh-banner-probe.mjs";
import { execSshCapture } from "../bin/lib/ssh-exec.mjs";
import { listTasks, readTask, readTaskLog } from "../bin/lib/task-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_CLI_PATH = path.resolve(__dirname, "..", "bin", "orca-colab.mjs");
const BUNDLED_SKILL_DIR = path.resolve(__dirname, "..", "skills", "colab-gpu");

export function syncBundledSkillToAgentDirs(homeDir = os.homedir()) {
  const skillMdSrc = path.join(BUNDLED_SKILL_DIR, "SKILL.md");
  const cliMdSrc = path.join(BUNDLED_SKILL_DIR, "references", "cli.md");
  if (!existsSync(skillMdSrc)) {
    return { installed: false, targets: [] };
  }

  const targetRoots = [
    path.join(homeDir, ".agents", "skills", "colab-gpu"),
    path.join(homeDir, ".claude", "skills", "colab-gpu"),
    path.join(homeDir, ".gemini", "config", "skills", "colab-gpu"),
  ];

  const installedTargets = [];
  for (const destDir of targetRoots) {
    try {
      const refDir = path.join(destDir, "references");
      mkdirSync(refDir, { recursive: true });
      copyFileSync(skillMdSrc, path.join(destDir, "SKILL.md"));
      if (existsSync(cliMdSrc)) {
        copyFileSync(cliMdSrc, path.join(refDir, "cli.md"));
      }
      installedTargets.push(destDir);
    } catch {
      // Non-fatal if a specific agent directory is read-only.
    }
  }
  return {
    installed: installedTargets.length > 0,
    targets: installedTargets,
  };
}

let cleanupFns = [];

async function resolveWorkspaceInfo(orca) {
  let workspaceId = null;
  let workspacePath = null;
  try {
    const [ctx, listRes] = await Promise.all([
      orca.host.call("workspace.readContext", {}).catch(() => null),
      orca.host.call("workspace.list", {}).catch(() => null),
    ]);
    const rows = Array.isArray(listRes)
      ? listRes
      : Array.isArray(listRes?.workspaces)
        ? listRes.workspaces
        : [];
    if (rows.length > 0) {
      const matched =
        rows.find(
          (w) =>
            (ctx?.displayName && w.name === ctx.displayName) ||
            (ctx?.branch && w.branch === ctx.branch),
        ) || rows[0];
      workspaceId = matched?.id || null;
      workspacePath = matched?.path || null;
    }
  } catch {
    // Ignore workspace resolution errors when no workspace is open.
  }
  return { workspaceId, workspacePath };
}

async function resolveCliCommand(orca) {
  if (existsSync(LOCAL_CLI_PATH)) {
    return `node ${JSON.stringify(LOCAL_CLI_PATH)}`;
  }
  try {
    const configured = await orca.settings.get("cliCommand");
    if (typeof configured === "string" && configured.trim()) {
      return configured.trim();
    }
  } catch {
    // Use default.
  }
  return "npx -y github:vzxxbacq/orca-colab#v0.1.0";
}

async function openTerminalWithCommand(orca, { title, command }) {
  const { workspaceId } = await resolveWorkspaceInfo(orca);
  if (!workspaceId) {
    throw new Error("No active Orca workspace found to open a terminal.");
  }
  return await orca.host.call("terminal.create", {
    workspaceId,
    title: title || "Colab GPU",
    command,
  });
}

function queryLiveGpuMetricsViaSsh(ip, homeDir) {
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

export default async function activate(orca, { homeDir = os.homedir() } = {}) {
  const paths = ensureColabHome(homeDir);
  const skillSync = syncBundledSkillToAgentDirs(homeDir);
  const gpuUtilSamplesBySession = new Map();
  const graceTimersBySession = new Map();
  const budgetNotifiedKeys = {};
  let selectedTaskId = null;
  let lastStreamedSnapshot = "";
  let provisioningState = { active: false, message: null, error: null };

  const notifyUser = async (message, tone = "info") => {
    try {
      if (await orca.host.has("notifications.show")) {
        await orca.host.call("notifications.show", {
          title: "Google Colab GPU",
          message,
          tone,
        });
      }
    } catch {
      // Ignore notification error.
    }
  };

  const buildDashboardSnapshot = async ({ includeLiveMetrics = false } = {}) => {
    const config = readConfig(homeDir);
    const defaultAccount = resolveAccount(config).label;
    const accounts =
      Array.isArray(config?.accounts) && config.accounts.length > 0
        ? config.accounts.map((a) => a.label)
        : ["default"];

    const sessions = listSessions(homeDir);
    const tasks = listTasks(homeDir);
    const events = readLedgerEvents(homeDir);
    const rates = readRateTable(homeDir);

    const enrichedSessions = await Promise.all(
      sessions.map(async (s) => {
        const ageSeconds = Math.max(
          0,
          Math.floor((Date.now() - Date.parse(s.createdAt)) / 1000),
        );
        const sessionRunningTasks = tasks.filter(
          (t) => t.sessionName === s.name && t.status === "running",
        ).length;
        const samples = gpuUtilSamplesBySession.get(s.name) || [];
        const idleInfo = evaluateSessionIdleState({
          session: s,
          gpuSamples: samples,
          runningTasksCount: sessionRunningTasks,
          nowMs: Date.now(),
        });

        let reachable = s.state !== "zombie";
        let liveMetrics = null;
        if (includeLiveMetrics && s.state !== "zombie") {
          if (s.ip) {
            const probe = await probeSshBannerOnce({
              host: s.ip,
              port: 22,
              timeoutMs: 2500,
            }).catch(() => ({ ok: false }));
            reachable = Boolean(probe?.ok);
          }

          if (s.colabRuntime?.baseUrl && s.colabRuntime?.token) {
            try {
              const resInfo = await getRuntimeResources({
                baseUrl: s.colabRuntime.baseUrl,
                proxyToken: s.colabRuntime.token,
              });
              const g0 = Array.isArray(resInfo?.gpus) ? resInfo.gpus[0] : null;
              liveMetrics = {
                gpuUtilizationPercent:
                  typeof g0?.gpuUtilization === "number"
                    ? Math.round(g0.gpuUtilization * 100)
                    : null,
                vramUsedMiB:
                  typeof g0?.memoryUsedBytes === "number"
                    ? Math.round(g0.memoryUsedBytes / (1024 * 1024))
                    : null,
                vramTotalMiB:
                  typeof g0?.memoryTotalBytes === "number"
                    ? Math.round(g0.memoryTotalBytes / (1024 * 1024))
                    : s.gpu?.memoryTotalMiB || null,
                ramTotalGiB:
                  typeof resInfo?.memory?.totalBytes === "number"
                    ? Number(
                        (
                          resInfo.memory.totalBytes /
                          (1024 * 1024 * 1024)
                        ).toFixed(1),
                      )
                    : null,
                ramUsedGiB:
                  typeof resInfo?.memory?.totalBytes === "number" &&
                  typeof resInfo?.memory?.freeBytes === "number"
                    ? Number(
                        (
                          (resInfo.memory.totalBytes -
                            resInfo.memory.freeBytes) /
                          (1024 * 1024 * 1024)
                        ).toFixed(1),
                      )
                    : null,
              };
            } catch {
              // Fall back to SSH nvidia-smi below if IP is present.
            }
          }

          if (!liveMetrics && s.ip && reachable) {
            liveMetrics = queryLiveGpuMetricsViaSsh(s.ip, homeDir);
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
      }),
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

    const activeTask =
      (selectedTaskId && tasks.find((t) => t.id === selectedTaskId)) ||
      tasks.find((t) => t.status === "running") ||
      tasks[0] ||
      null;

    let activeTaskOutput = null;
    if (activeTask) {
      const logSnap = readTaskLog(activeTask.id, homeDir, { tailLines: 250 });
      activeTaskOutput = {
        taskId: activeTask.id,
        status: activeTask.status,
        exitCode: activeTask.exitCode,
        output: logSnap.text,
        totalBytes: logSnap.totalBytes,
        truncated: logSnap.truncated,
      };
    }

    const doctor = runDoctor({ homeDir, env: process.env });

    return {
      defaultAccount,
      accounts,
      doctor,
      policy: resolveAgentPolicy(config),
      skillSync,
      provisioning: provisioningState,
      auth: authByAccount[defaultAccount] || {
        account: defaultAccount,
        authenticated: false,
      },
      authByAccount,
      sessions: enrichedSessions,
      credits: creditsByAccount[defaultAccount],
      creditsByAccount,
      tasks,
      activeTaskOutput,
      rates,
    };
  };

  const refreshStatusBar = async () => {
    try {
      const snap = await buildDashboardSnapshot({ includeLiveMetrics: false });
      const activeSessions = snap.sessions.filter((s) => s.state !== "zombie");
      const runningTasks = snap.tasks.filter((t) => t.status === "running");
      const primaryCredits = snap.credits;

      const monthKey = new Date().toISOString().slice(0, 7);
      const budgetState = evaluateBudgetAlert({
        projection: primaryCredits,
        monthKey,
        alreadyNotified: budgetNotifiedKeys,
      });

      if (budgetState.shouldNotify && budgetState.notifyKey) {
        budgetNotifiedKeys[budgetState.notifyKey] = true;
        await notifyUser(
          `Colab monthly compute budget reached ${budgetState.alertLevel} (${primaryCredits.estimatedMonthlyUsedCu} / ${primaryCredits.budgetCu} CU).`,
          budgetState.tone === "danger" ? "error" : "warning",
        );
      }

      if (
        activeSessions.length === 0 &&
        runningTasks.length === 0 &&
        primaryCredits?.estimatedBalanceCu === null
      ) {
        await orca.host.call("statusBar.update", {
          id: "colab-sessions",
          text: "Colab",
          icon: "zap",
          visible: false,
        });
        return;
      }

      const parts = [];
      if (activeSessions.length > 0) {
        const s0 = activeSessions[0];
        const gpuLabel = s0.rateKey && s0.rateKey !== "unknown" ? s0.rateKey : "GPU";
        parts.push(
          activeSessions.length > 1
            ? `${activeSessions.length}×${gpuLabel}`
            : gpuLabel,
        );
        parts.push(`${primaryCredits.estimatedBurnCuPerHour} CU/h`);
      }
      if (runningTasks.length > 0) {
        parts.push(
          runningTasks.length === 1
            ? `1 task`
            : `${runningTasks.length} tasks`,
        );
      }
      if (primaryCredits?.estimatedBalanceCu !== null) {
        parts.push(`≈${Math.round(primaryCredits.estimatedBalanceCu)} CU`);
      }

      const text = `Colab: ${parts.join(" · ") || "Idle"}`;
      await orca.host.call("statusBar.update", {
        id: "colab-sessions",
        text,
        icon: "zap",
        tone: budgetState.tone,
        tooltip: "Click to open Google Colab GPU & Task Manager panel",
        visible: true,
      });
    } catch (err) {
      orca.log(`statusBar update error: ${err?.message || err}`);
    }
  };

  const broadcastTaskStreamIfChanged = () => {
    try {
      const tasks = listTasks(homeDir);
      const target =
        (selectedTaskId && tasks.find((t) => t.id === selectedTaskId)) ||
        tasks.find((t) => t.status === "running") ||
        tasks[0] ||
        null;
      if (!target) {
        return;
      }
      const logSnap = readTaskLog(target.id, homeDir, { tailLines: 250 });
      const fingerprint = `${target.id}:${target.status}:${target.exitCode}:${logSnap.totalBytes}`;
      if (fingerprint !== lastStreamedSnapshot) {
        lastStreamedSnapshot = fingerprint;
        orca.panels.post("colab.taskOutput", {
          task: target,
          output: logSnap.text,
          totalBytes: logSnap.totalBytes,
          truncated: logSnap.truncated,
        });
      }
    } catch {
      // Ignore transient read error.
    }
  };

  const sampleWatchdogAndKeepalive = async () => {
    const sessions = listSessions(homeDir).filter((s) => s.state !== "zombie");
    const tasks = listTasks(homeDir);
    let autoStopIdleMinutes = DEFAULT_AUTO_STOP_IDLE_MINUTES;
    try {
      const val = await orca.settings.get("autoStopIdleMinutes");
      if (typeof val === "number" && val >= 0) {
        autoStopIdleMinutes = val;
      }
    } catch {
      // Default 20 min.
    }

    for (const s of sessions) {
      if (s.colabRuntime?.id) {
        try {
          const accessToken = await getValidAccessToken({
            account: s.account || "default",
            homeDir,
          });
          if (accessToken) {
            const refreshed = await getRuntime({
              runtimeId: s.colabRuntime.id,
              accessToken,
            });
            if (refreshed?.connectionInfo?.token) {
              writeSession(
                {
                  ...s,
                  colabRuntime: {
                    ...s.colabRuntime,
                    token: refreshed.connectionInfo.token,
                    tokenExpiry:
                      refreshed.connectionInfo.expireTime ||
                      s.colabRuntime.tokenExpiry,
                  },
                },
                homeDir,
              );
            }
          }
        } catch {
          // Non-fatal keepalive refresh error.
        }
      }

      if (s.ip) {
        const metrics = queryLiveGpuMetricsViaSsh(s.ip, homeDir);
        if (metrics && typeof metrics.gpuUtilizationPercent === "number") {
          const prev = gpuUtilSamplesBySession.get(s.name) || [];
          const next = [...prev.slice(-5), metrics.gpuUtilizationPercent];
          gpuUtilSamplesBySession.set(s.name, next);
        }
      }

      const runningCount = tasks.filter(
        (t) => t.sessionName === s.name && t.status === "running",
      ).length;

      const decision = evaluateSessionIdleState({
        session: s,
        gpuSamples: gpuUtilSamplesBySession.get(s.name) || [],
        runningTasksCount: runningCount,
        autoStopIdleMinutes,
        nowMs: Date.now(),
      });

      if (decision.isIdle && !graceTimersBySession.has(s.name)) {
        await notifyUser(
          `Colab session ${s.name} has been idle for ${Math.round(decision.idleMinutes)} min (<5% GPU). Stopping in ${GRACE_PERIOD_MINUTES} min unless used or marked Keep.`,
          "warning",
        );
        const timer = setTimeout(async () => {
          graceTimersBySession.delete(s.name);
          const latestSession = readSession(s.name, homeDir);
          const latestRunning = listTasks(homeDir).filter(
            (t) => t.sessionName === s.name && t.status === "running",
          ).length;
          const recheck = evaluateSessionIdleState({
            session: latestSession,
            gpuSamples: gpuUtilSamplesBySession.get(s.name) || [],
            runningTasksCount: latestRunning,
            autoStopIdleMinutes,
            nowMs: Date.now(),
          });
          if (recheck.isIdle) {
            const nullStream = { write() {} };
            await runDownCommand(
              ["--session", s.name, "--cause", "idle-watchdog"],
              {
                json: true,
                stdout: nullStream,
                stderr: nullStream,
                homeDir,
              },
            ).catch(() => {});
            await notifyUser(
              `Auto-stopped idle Colab session ${s.name} to save compute units.`,
              "info",
            );
            await refreshStatusBar();
            orca.panels.post("colab.stateChanged", await buildDashboardSnapshot());
          }
        }, GRACE_PERIOD_MINUTES * 60_000);
        graceTimersBySession.set(s.name, timer);
      } else if (!decision.isIdle && graceTimersBySession.has(s.name)) {
        clearTimeout(graceTimersBySession.get(s.name));
        graceTimersBySession.delete(s.name);
      }
    }
  };

  orca.commands.register("colab.up", async () => {
    const cli = await resolveCliCommand(orca);
    await openTerminalWithCommand(orca, {
      title: "Colab: Start GPU",
      command: `${cli} up`,
    });
  });

  orca.commands.register("colab.down", async () => {
    const cli = await resolveCliCommand(orca);
    await openTerminalWithCommand(orca, {
      title: "Colab: Stop GPU",
      command: `${cli} down`,
    });
  });

  orca.commands.register("colab.showPanel", async () => {
    const orcaBin = locateOrcaBinary(process.env) || "orca";
    for (const key of ["vzxxbacq.colab", "local.colab"]) {
      const child = spawn(orcaBin, ["plugin", "open", key, "--panel", "colab"], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
    }
  });

  orca.panels.handle("colab.dashboard", async (input = {}) => {
    if (input?.selectedTaskId) {
      selectedTaskId = String(input.selectedTaskId);
    }
    return await buildDashboardSnapshot({
      includeLiveMetrics: Boolean(input?.includeLiveMetrics),
    });
  });

  orca.panels.handle("colab.sessions", async () => {
    return await buildDashboardSnapshot({ includeLiveMetrics: true });
  });

  orca.panels.handle("colab.doctor", async () => {
    return runDoctor({ homeDir, env: process.env });
  });

  orca.panels.handle("colab.setupConfig", async (input = {}) => {
    const authKey = String(input?.authKey || "").trim();
    if (!authKey) {
      throw new Error("Tailscale auth key is required.");
    }
    const args = ["--auth-key", authKey, "--non-interactive", "--no-open"];
    if (input?.loginServer && String(input.loginServer).trim()) {
      args.push("--login-server", String(input.loginServer).trim());
    }
    if (input?.notebookUrl && String(input.notebookUrl).trim()) {
      args.push("--notebook-url", String(input.notebookUrl).trim());
    }
    const nullStream = { write() {} };
    await runSetupCommand(args, {
      json: true,
      stdout: nullStream,
      stderr: nullStream,
      env: process.env,
      homeDir,
    });
    const snap = await buildDashboardSnapshot();
    const doc = runDoctor({ homeDir, env: process.env });
    orca.panels.post("colab.stateChanged", snap);
    return { ok: true, dashboard: snap, doctor: doc };
  });

  orca.panels.handle("colab.updatePolicy", async (input = {}) => {
    const existing = readConfig(homeDir) || {};
    const currentPolicy = resolveAgentPolicy(existing);
    const nextAllowed =
      Array.isArray(input?.allowedGpus) && input.allowedGpus.length > 0
        ? input.allowedGpus.map((g) => String(g).trim().toUpperCase())
        : currentPolicy.allowedGpus;
    const nextMaxConcurrent =
      typeof input?.maxConcurrentSessions === "number" &&
      Number.isFinite(input.maxConcurrentSessions) &&
      input.maxConcurrentSessions >= 1
        ? Math.floor(input.maxConcurrentSessions)
        : currentPolicy.maxConcurrentSessions;

    writeConfig(
      {
        ...existing,
        allowedGpus: nextAllowed,
        maxConcurrentSessions: nextMaxConcurrent,
      },
      homeDir,
    );
    const snap = await buildDashboardSnapshot();
    orca.panels.post("colab.stateChanged", snap);
    return { ok: true, policy: snap.policy, dashboard: snap };
  });

  orca.panels.handle("colab.authLogin", async (input = {}) => {
    const config = readConfig(homeDir);
    const account = resolveAccount(config, input?.account).label;
    const status = await runLoopbackOAuthFlow({
      account,
      homeDir,
      onAuthUrl: (authUrl) => {
        orca.panels.post("colab.oauthUrl", { authUrl });
      },
    });
    try {
      const accessToken = await getValidAccessToken({ account, homeDir });
      if (accessToken) {
        const ccu = await getConsumptionUserInfo({ accessToken });
        if (typeof ccu.paidComputeUnitsBalance === "number") {
          recordCalibrateEvent(
            {
              account,
              balanceCu: ccu.paidComputeUnitsBalance,
              source: "colab-api",
            },
            homeDir,
          );
        }
      }
    } catch {
      // Non-fatal.
    }
    await refreshStatusBar();
    const snap = await buildDashboardSnapshot();
    orca.panels.post("colab.stateChanged", snap);
    return { ok: true, status, dashboard: snap };
  });

  orca.panels.handle("colab.authLogout", async (input = {}) => {
    const config = readConfig(homeDir);
    const account = resolveAccount(config, input?.account).label;
    removeOAuthCredentials(account, homeDir);
    const snap = await buildDashboardSnapshot();
    orca.panels.post("colab.stateChanged", snap);
    return { ok: true, dashboard: snap };
  });

  orca.panels.handle("colab.startSession", async (input = {}) => {
    const gpu = String(input?.gpu || "T4").toUpperCase();
    const account = input?.account || undefined;
    const keep = Boolean(input?.keep);
    const useTerminal = Boolean(input?.useTerminal);
    const runAsync = Boolean(input?.async);

    const authStatus = readOAuthAccountStatus(account || "default", homeDir);
    if (useTerminal || !authStatus.authenticated) {
      const cli = await resolveCliCommand(orca);
      const flags = [`--gpu ${gpu}`];
      if (account) flags.push(`--account ${account}`);
      if (keep) flags.push("--keep");
      await openTerminalWithCommand(orca, {
        title: `Colab: Start ${gpu}`,
        command: `${cli} up ${flags.join(" ")}`,
      });
      return { ok: true, mode: "terminal" };
    }

    if (provisioningState.active) {
      return {
        ok: true,
        mode: "already-provisioning",
        dashboard: await buildDashboardSnapshot(),
      };
    }

    provisioningState = {
      active: true,
      message: `Assigning Colab ${gpu} runtime via Google Colab Direct API...`,
      error: null,
    };
    const initialSnap = await buildDashboardSnapshot();
    orca.panels.post("colab.stateChanged", initialSnap);

    const args = ["--gpu", gpu];
    if (account) args.push("--account", String(account));
    if (keep) args.push("--keep");

    const logStream = {
      write(chunk) {
        const line = String(chunk).replace(/^\[colab\]\s*/, "").trim();
        if (line) {
          provisioningState = { active: true, message: line, error: null };
          orca.panels.post("colab.provisioningProgress", provisioningState);
        }
      },
    };
    const outStream = { write() {} };

    const startMs = Date.now();
    const tickTimer = setInterval(() => {
      if (provisioningState.active) {
        const sec = Math.floor((Date.now() - startMs) / 1000);
        const baseMsg =
          provisioningState.message?.replace(/\s*\(\d+s.*\)$/, "") ||
          `Assigning Colab ${gpu} runtime...`;
        const progressNext = {
          active: true,
          message: `${baseMsg} (${sec}s elapsed)`,
          error: null,
        };
        provisioningState = progressNext;
        orca.panels.post("colab.provisioningProgress", progressNext);
      }
    }, 2000);

    const executeProvisioning = async () => {
      try {
        await runUpCommand(args, {
          json: true,
          stdout: outStream,
          stderr: logStream,
          env: process.env,
          homeDir,
        });
        clearInterval(tickTimer);
        provisioningState = { active: false, message: null, error: null };
        orca.panels.post("colab.provisioningProgress", provisioningState);
        await refreshStatusBar();
        const snap = await buildDashboardSnapshot({ includeLiveMetrics: true });
        orca.panels.post("colab.stateChanged", snap);
        return { ok: true, mode: "direct-api", dashboard: snap };
      } catch (err) {
        clearInterval(tickTimer);
        const msg = err instanceof Error ? err.message : String(err);
        provisioningState = { active: false, message: null, error: msg };
        orca.panels.post("colab.provisioningProgress", provisioningState);
        const snap = await buildDashboardSnapshot();
        orca.panels.post("colab.stateChanged", snap);
        throw err;
      }
    };

    if (runAsync) {
      executeProvisioning().catch((err) => {
        orca.log(`startSession async error: ${err?.message || err}`);
      });
      return { ok: true, mode: "direct-api-async", dashboard: initialSnap };
    }

    return await executeProvisioning();
  });

  orca.panels.handle("colab.stopSession", async (input = {}) => {
    const args = input?.session ? ["--session", String(input.session)] : [];
    const nullStream = { write() {} };
    await runDownCommand(args, {
      json: true,
      stdout: nullStream,
      stderr: nullStream,
      homeDir,
    });
    await refreshStatusBar();
    const snap = await buildDashboardSnapshot();
    orca.panels.post("colab.stateChanged", snap);
    return { ok: true, dashboard: snap };
  });

  orca.panels.handle("colab.toggleKeep", async (input = {}) => {
    const session = readSession(String(input?.session || ""), homeDir);
    if (!session) {
      throw new Error(`Session not found: ${input?.session}`);
    }
    writeSession({ ...session, keep: !session.keep }, homeDir);
    const snap = await buildDashboardSnapshot();
    orca.panels.post("colab.stateChanged", snap);
    return { ok: true, dashboard: snap };
  });

  orca.panels.handle("colab.submitTask", async (input = {}) => {
    const rawCommand = String(input?.command || "").trim();
    if (!rawCommand) {
      throw new Error("Task command cannot be empty.");
    }
    const activeSessions = listSessions(homeDir).filter(
      (s) => s.state !== "zombie",
    );
    if (activeSessions.length === 0) {
      return {
        ok: false,
        code: "NO_ACTIVE_SESSION",
        message:
          "No active Colab GPU runtime. Let's launch a GPU session first.",
        dashboard: await buildDashboardSnapshot(),
      };
    }
    const { workspacePath } = await resolveWorkspaceInfo(orca);
    const syncPath = input?.syncWorkspace
      ? workspacePath || process.cwd()
      : null;

    const { task } = await submitTask(
      {
        name: input?.name ? String(input.name).trim() : undefined,
        command: [rawCommand],
        sessionName: input?.session || undefined,
        cwd: input?.cwd ? String(input.cwd).trim() : null,
        syncPath,
        wait: false,
      },
      {
        homeDir,
        localCwd: workspacePath || process.cwd(),
        env: process.env,
      },
    );

    selectedTaskId = task.id;
    await refreshStatusBar();
    const snap = await buildDashboardSnapshot();
    orca.panels.post("colab.stateChanged", snap);
    return { ok: true, task, dashboard: snap };
  });

  orca.panels.handle("colab.stopTask", async (input = {}) => {
    const taskId = String(input?.taskId || "");
    const stopped = stopTaskById(taskId, { homeDir });
    await refreshStatusBar();
    const snap = await buildDashboardSnapshot();
    orca.panels.post("colab.stateChanged", snap);
    return { ok: true, task: stopped, dashboard: snap };
  });

  orca.panels.handle("colab.getTaskLogs", async (input = {}) => {
    const taskId = String(input?.taskId || "");
    selectedTaskId = taskId;
    const task = readTask(taskId, homeDir);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const logSnap = readTaskLog(taskId, homeDir, {
      tailLines: Number(input?.tailLines || 300),
    });
    return {
      ok: true,
      task,
      output: logSnap.text,
      totalBytes: logSnap.totalBytes,
      truncated: logSnap.truncated,
    };
  });

  orca.panels.handle("colab.calibrateCredits", async (input = {}) => {
    const args = ["calibrate"];
    if (input?.account) args.push("--account", String(input.account));
    if (input?.browser) args.push("--browser");
    const nullStream = { write() {} };
    await runCreditsCommand(args, {
      json: true,
      stdout: nullStream,
      stderr: nullStream,
      env: process.env,
      homeDir,
    });
    await refreshStatusBar();
    const snap = await buildDashboardSnapshot();
    orca.panels.post("colab.stateChanged", snap);
    return { ok: true, dashboard: snap };
  });

  orca.panels.handle("colab.setCredits", async (input = {}) => {
    const balanceCu = Number(input?.balanceCu);
    if (!Number.isFinite(balanceCu) || balanceCu < 0) {
      throw new Error("Balance must be a non-negative number.");
    }
    const config = readConfig(homeDir);
    const account = resolveAccount(config, input?.account).label;
    recordCalibrateEvent({ account, balanceCu, source: "manual" }, homeDir);
    await refreshStatusBar();
    const snap = await buildDashboardSnapshot();
    orca.panels.post("colab.stateChanged", snap);
    return { ok: true, dashboard: snap };
  });

  orca.panels.handle("colab.setBudget", async (input = {}) => {
    const budgetCu = Number(input?.budgetCu);
    if (!Number.isFinite(budgetCu) || budgetCu < 0) {
      throw new Error("Budget must be a non-negative number.");
    }
    const config = readConfig(homeDir);
    const account = resolveAccount(config, input?.account).label;
    recordBudgetSetEvent({ account, budgetCu }, homeDir);
    await refreshStatusBar();
    const snap = await buildDashboardSnapshot();
    orca.panels.post("colab.stateChanged", snap);
    return { ok: true, dashboard: snap };
  });

  orca.panels.handle("colab.openTerminal", async (input = {}) => {
    const activeSessions = listSessions(homeDir).filter(
      (s) => s.state !== "zombie",
    );
    if (!input?.command && activeSessions.length === 0) {
      return {
        ok: false,
        code: "NO_ACTIVE_SESSION",
        message:
          "No active Colab GPU runtime. Launch a GPU session first to open an SSH shell.",
      };
    }
    const targetSession = input?.session || activeSessions[0]?.name;
    const cli = await resolveCliCommand(orca);
    const cmd = targetSession
      ? `${cli} run --session ${targetSession} -- bash -l`
      : input?.command || `${cli} status`;
    await openTerminalWithCommand(orca, {
      title: input?.title || (targetSession ? `SSH: ${targetSession}` : "Colab Shell"),
      command: cmd,
    });
    return { ok: true };
  });

  for (const dirPath of [paths.baseDir, paths.sessionsDir, paths.tasksDir]) {
    try {
      const watcher = watch(dirPath, () => {
        broadcastTaskStreamIfChanged();
        void refreshStatusBar();
      });
      cleanupFns.push(() => watcher.close());
    } catch {
      // Ignore watch error if dir not ready.
    }
  }

  const streamInterval = setInterval(() => {
    broadcastTaskStreamIfChanged();
  }, 1500);
  const statusInterval = setInterval(() => {
    void refreshStatusBar();
  }, 30_000);
  const watchdogInterval = setInterval(() => {
    void sampleWatchdogAndKeepalive();
  }, 5 * 60_000);

  cleanupFns.push(() => clearInterval(streamInterval));
  cleanupFns.push(() => clearInterval(statusInterval));
  cleanupFns.push(() => clearInterval(watchdogInterval));

  await refreshStatusBar();
}

export function deactivate() {
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch {
      // Ignore cleanup errors.
    }
  }
  cleanupFns = [];
}
