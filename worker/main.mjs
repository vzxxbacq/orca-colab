import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { locateOrcaBinary } from "../bin/lib/orca-binary.mjs";
import { ensureColabHome } from "../bin/lib/colab-home.mjs";
import { DashboardSnapshotBuilder, pickActiveTask } from "../bin/lib/dashboard-snapshot.mjs";
import {
  DEFAULT_AUTO_STOP_IDLE_MINUTES,
  evaluateBudgetAlert,
  evaluateSessionIdleState,
  GRACE_PERIOD_MINUTES,
} from "../bin/lib/idle-watchdog.mjs";
import { estimateProjectMonthlyUse, readLedgerEvents } from "../bin/lib/credit-ledger.mjs";
import { createPanelActions, PANEL_ACTION_NAMES } from "../bin/lib/panel-actions.mjs";
import { describeProjectGuardrails } from "../bin/lib/project-guardrails.mjs";
import { createRuntimeChannel } from "../bin/lib/runtime-channel.mjs";
import { describeOrigin, machineName, stampRuntimeActivity } from "../bin/lib/runtime-records.mjs";
import { openRuntimeShell } from "../bin/lib/runtime-shell.mjs";
import { listSessions, readSession } from "../bin/lib/session-store.mjs";
import { createOrcaRemoteHelper } from "../bin/lib/orca-remote-helper.mjs";
import { listTasks, readTaskLog } from "../bin/lib/task-store.mjs";
import { inspectAgentSkills, installAgentSkill, removeAgentSkill } from "./agent-skill-install.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_CLI_PATH = path.resolve(__dirname, "..", "bin", "orca-colab.mjs");
const DEFAULT_CLI_COMMAND = "npx -y https://codeload.github.com/vzxxbacq/orca-colab/tar.gz/1a5345295e390b47165aa8cd708d71c22df2ee6f";

let cleanupFns = [];

// Orca reports the machine it runs on as host "local" (observed on 1.4.254), not as null.
export function isRemoteHostId(hostId) {
  return typeof hostId === "string" && hostId.trim() !== "" && hostId.trim().toLowerCase() !== "local";
}

function workspaceRows(listRes) {
  return Array.isArray(listRes) ? listRes : Array.isArray(listRes?.workspaces) ? listRes.workspaces : [];
}

// readContext has no id, so the focused workspace is matched against the list by name and branch.
// Several local checkouts may share a name such as `main`; the focused workspace's terminals decide
// between them, and a focused workspace whose terminals no local worktree owns lives on a server.
export async function resolveWorkspaceInfo(orca, { locateTerminals = null, stickyRemote = null } = {}) {
  try {
    const [ctx, listRes] = await Promise.all([
      orca.host.call("workspace.readContext", {}).catch(() => null),
      orca.host.call("workspace.list", {}).catch(() => null),
    ]);
    const rows = workspaceRows(listRes);
    const terminals = Array.isArray(ctx?.terminals) ? ctx.terminals : [];
    const byName = (w) => Boolean(ctx?.displayName) && w.name === ctx.displayName;
    const byBranch = (w) => Boolean(ctx?.branch) && w.branch === ctx.branch;
    const candidates = [
      ...rows.filter((w) => byName(w) && byBranch(w)),
      ...rows.filter((w) => byName(w) !== byBranch(w)),
    ];
    let matched = candidates[0] || null;
    if (ctx?.displayName && terminals.length && typeof locateTerminals === "function") {
      const located = await locateTerminals(terminals);
      if (located === false) {
        matched = null;
      } else if (located?.path) {
        matched = rows.find((w) => w.path === located.path) || matched;
      } else if (located === null && matched && stickyRemote?.has(`${ctx.displayName}|${ctx.branch || ""}`)) {
        matched = null;
      }
    }
    // Workspaces on a remote Orca server are missing from workspace.list on the client (observed on
    // 1.4.254) while readContext still names the focused one, so "focused but unlisted" means remote.
    if (!matched && ctx?.displayName) {
      return {
        workspaceId: null,
        workspacePath: null,
        workspaceName: ctx.displayName,
        branch: ctx.branch || null,
        hostId: "unlisted",
        terminals,
      };
    }
    const row = matched || rows[0];
    return {
      workspaceId: row?.id || null,
      workspacePath: row?.path || null,
      workspaceName: row?.name || null,
      branch: row?.branch || ctx?.branch || null,
      hostId: isRemoteHostId(row?.hostId) ? row.hostId : null,
      terminals,
    };
  } catch {
    return { workspaceId: null, workspacePath: null, workspaceName: null, hostId: null, terminals: [] };
  }
}

async function readSetting(orca, key, fallback) {
  try {
    const value = await orca.settings.get(key);
    return value === undefined || value === null || value === "" ? fallback : value;
  } catch {
    return fallback;
  }
}

// The command a user pastes into a terminal of their own (the panel shows it for a full interactive shell).
async function resolveCliCommand(orca) {
  if (existsSync(LOCAL_CLI_PATH)) {
    return `node ${JSON.stringify(LOCAL_CLI_PATH)}`;
  }
  const configured = await readSetting(orca, "cliCommand", null);
  return typeof configured === "string" && configured.trim() ? configured.trim() : DEFAULT_CLI_COMMAND;
}

function listFingerprint(snap) {
  const tasks = (snap?.tasks || []).map((t) => `${t.id}:${t.status}:${t.exitCode}:${t.finishedAt || ""}`);
  const sessions = (snap?.sessions || []).map((s) => `${s.name}:${s.state}:${s.keep ? 1 : 0}`);
  return `${tasks.join("|")}#${sessions.join("|")}`;
}

// The panel's one source: ~/.orca-colab on this machine, kept in line with the Google account signed in
// here (Colab's runtime list, and the records on each runtime). Which Orca workspace is focused, local
// or on a remote Orca server, does not change what it shows.
class AccountDashboard {
  constructor({ orca, homeDir, env, notifyUser, onSnapshot, isPanelActive }) {
    this.orca = orca;
    this.homeDir = homeDir;
    this.env = env;
    this.notifyUser = notifyUser;
    this.onSnapshot = onSnapshot;
    this.isPanelActive = isPanelActive;
    this.builder = new DashboardSnapshotBuilder({
      homeDir,
      env,
      origin: { kind: "local", host: machineName(env), platform: process.platform },
    });
    this.actions = createPanelActions({ homeDir, env });
    this.provisioningState = { active: false, message: null, error: null };
    this.selectedTaskId = null;
    this.lastListFp = "";
    this.lastStreamFp = "";
    this.lastNewestTaskId = null;
    this.graceTimers = new Map();
    this.timers = [];
    this.watchers = [];
  }

  selectTask(taskId) {
    this.selectedTaskId = taskId || null;
  }

  async snapshot({ includeLiveMetrics = false } = {}) {
    // The first snapshot waits for the account's runtimes; later ones refresh them in the background.
    const sync = this.builder.syncFromRuntimes({ maxAgeMs: this.isPanelActive() ? 5_000 : 60_000 });
    if (!this.builder.lastRuntimeSyncAt) {
      await Promise.race([sync, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    return this.builder.build({
      includeLiveMetrics,
      selectedTaskId: this.selectedTaskId,
      provisioningState: this.provisioningState,
    });
  }

  async call(action, input, hooks = {}) {
    const fn = this.actions[action];
    if (typeof fn !== "function") {
      throw new Error(`unknown action: ${action}`);
    }
    const result = await fn(input, hooks);
    if (action === "authLogin" || action === "authSwitch" || action === "authLogout") {
      this.builder.invalidateDoctor();
      this.builder.lastRuntimeSyncAt = 0;
      this.builder.lastDiscoveryAt = 0;
    }
    if (action === "submitTask" && result?.task?.id) {
      this.selectedTaskId = result.task.id;
    }
    return result;
  }

  start(paths) {
    for (const dirPath of [paths.baseDir, paths.sessionsDir, paths.tasksDir]) {
      try {
        const watcher = watch(dirPath, () => void this.broadcastIfChanged());
        this.watchers.push(watcher);
      } catch {
        // Directory not ready yet; the interval below still polls.
      }
    }
    this.timers.push(setInterval(() => void this.broadcastIfChanged(), 1500));
    this.timers.push(setInterval(() => void this.syncTick(), 2000));
    this.timers.push(setInterval(() => void this.watchdogTick(), 5 * 60_000));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // Already closed.
      }
    }
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.timers = [];
    this.watchers = [];
  }

  // Runtimes and jobs of other machines reach this one only by asking: every few seconds while the
  // panel is open, once a minute otherwise (the status bar and the watchdog still need them).
  async syncTick() {
    await this.builder.syncFromRuntimes({ maxAgeMs: this.isPanelActive() ? 5_000 : 60_000 });
  }

  async broadcastIfChanged() {
    try {
      const tasks = listTasks(this.homeDir);
      const newestId = tasks[0]?.id || null;
      if (newestId && newestId !== this.lastNewestTaskId) {
        if (this.lastNewestTaskId !== null) {
          this.selectedTaskId = newestId;
        }
        this.lastNewestTaskId = newestId;
      }
      const target = pickActiveTask(tasks, this.selectedTaskId);
      // The live output of a job no process here follows is copied from the runtime while it is watched.
      if (target?.runtimeBacked && !target.logComplete && this.isPanelActive()) {
        this.builder.copyTaskLog(target);
      }
      const logSnap = target ? readTaskLog(target.id, this.homeDir, { tailLines: 250 }) : null;
      const streamFp = target ? `${target.id}:${target.status}:${target.exitCode}:${logSnap.totalBytes}` : "";
      const listFp = listFingerprint({ tasks, sessions: listSessions(this.homeDir) });
      const changed = listFp !== this.lastListFp;
      this.lastListFp = listFp;
      if (changed) {
        const snap = await this.snapshot();
        this.onSnapshot(snap, { stateChanged: true });
      }
      if (target && streamFp !== this.lastStreamFp) {
        this.lastStreamFp = streamFp;
        this.onSnapshot(null, {
          taskOutput: {
            task: target,
            output: logSnap.text,
            totalBytes: logSnap.totalBytes,
            truncated: logSnap.truncated,
          },
        });
      }
    } catch {
      // Transient read error; the next tick retries.
    }
  }

  idleDecision(session, autoStopIdleMinutes) {
    const runningCount = listTasks(this.homeDir).filter(
      (t) => t.sessionName === session.name && t.status === "running",
    ).length;
    // Without a fresh read of the runtime's records nobody knows whether another machine is on it.
    const usage = this.builder.runtimeUsage(session.name);
    if (session.colabRuntime?.baseUrl && (!usage || Date.now() - usage.readAt > 3 * 60_000)) {
      return { isIdle: false, reason: "runtime-records-unread", consecutiveLowSamples: 0, idleMinutes: 0 };
    }
    return evaluateSessionIdleState({
      session,
      gpuSamples: this.builder.gpuUtilSamplesBySession.get(session.name) || [],
      runningTasksCount: runningCount,
      autoStopIdleMinutes,
      nowMs: Date.now(),
      runtimeUsage: usage,
    });
  }

  // Decides from the runtime's own records (jobs and commands of every machine), so a runtime another
  // machine's agent is busy on is never stopped from here. The sync also refreshes proxy tokens and
  // drops sessions whose runtime Colab no longer lists.
  async watchdogTick() {
    const { homeDir } = this;
    const autoStopIdleMinutes = Number(
      await readSetting(this.orca, "autoStopIdleMinutes", DEFAULT_AUTO_STOP_IDLE_MINUTES),
    );
    await this.builder.syncFromRuntimes({ maxAgeMs: 0 });
    // A runtime started under a project file that sets the idle minutes keeps them on every machine.
    const idleMinutesFor = (session) =>
      session.guardrails?.source === "project" && Number.isInteger(session.guardrails.autoStopIdleMinutes)
        ? session.guardrails.autoStopIdleMinutes
        : autoStopIdleMinutes;
    for (const s of listSessions(homeDir).filter((x) => x.state !== "zombie")) {
      const metrics = this.builder.liveMetricsBySession.get(s.name);
      if (metrics && typeof metrics.gpuUtilizationPercent === "number") {
        this.builder.recordGpuSample(s.name, metrics.gpuUtilizationPercent);
      }
      const decision = this.idleDecision(s, idleMinutesFor(s));
      if (decision.isIdle && !this.graceTimers.has(s.name)) {
        await this.notifyUser(
          `Colab session ${s.name} has been idle for ${Math.round(decision.idleMinutes)} min (<5% GPU). Stopping in ${GRACE_PERIOD_MINUTES} min unless used or marked Keep.`,
          "warning",
        );
        const timer = setTimeout(async () => {
          this.graceTimers.delete(s.name);
          await this.builder.syncFromRuntimes({ maxAgeMs: 0 });
          const latest = readSession(s.name, homeDir);
          if (latest && this.idleDecision(latest, idleMinutesFor(latest)).isIdle) {
            const res = await this.actions.stopSession({ session: s.name, cause: "idle-watchdog" }).catch(() => null);
            if (res && res.ok !== false) {
              await this.notifyUser(`Auto-stopped idle Colab session ${s.name} to save compute units.`, "info");
            }
            this.onSnapshot(await this.snapshot(), { stateChanged: true });
          }
        }, GRACE_PERIOD_MINUTES * 60_000);
        this.graceTimers.set(s.name, timer);
      } else if (!decision.isIdle && this.graceTimers.has(s.name)) {
        clearTimeout(this.graceTimers.get(s.name));
        this.graceTimers.delete(s.name);
      }
    }
  }
}

export default async function activate(orca, { homeDir = os.homedir() } = {}) {
  const paths = ensureColabHome(homeDir);
  const budgetNotifiedKeys = {};
  // ORCA_COLAB_DISABLE_ORCA_CLI=1 keeps tests from touching the real Orca on this machine.
  const orcaCli = createOrcaRemoteHelper(
    process.env.ORCA_COLAB_DISABLE_ORCA_CLI ? { orcaBin: null } : { env: process.env },
  );
  let lastResolveAt = 0;
  let resolvedWorkspace = null;

  const notifyUser = async (message, tone = "info") => {
    try {
      if (await orca.host.has("notifications.show")) {
        await orca.host.call("notifications.show", { title: "Colab GPU (Community) for Orca", message, tone });
      }
    } catch {
      // Notifications are optional.
    }
  };

  let lastPanelRequestAt = 0;
  const isPanelActive = () => Date.now() - lastPanelRequestAt < 10_000;

  const dashboard = new AccountDashboard({
    orca,
    homeDir,
    env: process.env,
    notifyUser,
    isPanelActive,
    onSnapshot: (snap, { stateChanged = false, taskOutput = null } = {}) => {
      if (stateChanged && snap) {
        orca.panels.post("colab.stateChanged", withWorkspace(snap));
        void refreshStatusBar(snap);
      }
      if (taskOutput) {
        orca.panels.post("colab.taskOutput", taskOutput);
      }
    },
  });
  dashboard.start(paths);

  // The focused workspace only matters for "sync this workspace before the job": its files are on this
  // machine or on a remote Orca server. A focused terminal that the local Orca lists pins the workspace
  // to that terminal's worktree; focused terminals it does not know mean the workspace is on a server.
  let localTerminalCache = { at: 0, byHandle: new Map() };
  const locateTerminals = async (terminals) => {
    const ids = (terminals || []).map((t) => t?.id).filter(Boolean);
    if (ids.length === 0 || !orcaCli.available) {
      return null;
    }
    if (Date.now() - localTerminalCache.at > 30_000) {
      const listed = await orcaCli.listTerminals(undefined);
      if (!listed.ok) return null;
      localTerminalCache = { at: Date.now(), byHandle: new Map(listed.data.map((t) => [t.handle, t])) };
    }
    const owned = ids.map((id) => localTerminalCache.byHandle.get(id)).find(Boolean);
    return owned ? { path: owned.worktreePath || null } : false;
  };
  const stickyRemote = new Set();

  const resolveWorkspace = async ({ force = false } = {}) => {
    if (!force && resolvedWorkspace && Date.now() - lastResolveAt < 2000) {
      return resolvedWorkspace;
    }
    lastResolveAt = Date.now();
    const info = await resolveWorkspaceInfo(orca, { locateTerminals, stickyRemote });
    if (info.hostId) {
      stickyRemote.add(`${info.workspaceName}|${info.branch || ""}`);
    }
    resolvedWorkspace = info;
    return info;
  };

  // The focused project's folder when its files are on this computer; only then can its
  // .orca/colab.json be read and written from here.
  const localProjectDir = () =>
    resolvedWorkspace?.workspacePath && !resolvedWorkspace.hostId ? resolvedWorkspace.workspacePath : null;

  const withWorkspace = (snap) => {
    const projectDir = localProjectDir();
    let projectGuardrails = null;
    if (projectDir) {
      projectGuardrails = describeProjectGuardrails(projectDir, homeDir);
      projectGuardrails.estimatedMonthlyUsedCu = estimateProjectMonthlyUse({
        events: readLedgerEvents(homeDir),
        activeSessions: listSessions(homeDir),
        project: projectGuardrails.project,
      });
    }
    return {
      ...snap,
      workspace: {
        name: resolvedWorkspace?.workspaceName || null,
        remote: Boolean(resolvedWorkspace?.hostId),
        hasLocalPath: Boolean(projectDir),
      },
      projectGuardrails,
    };
  };

  const refreshStatusBar = async (snapInput = null) => {
    try {
      const snap = snapInput || (await dashboard.snapshot());
      const activeSessions = (snap.sessions || []).filter((s) => s.state !== "zombie");
      const runningTasks = (snap.tasks || []).filter((t) => t.status === "running");
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
      const balance = primaryCredits?.estimatedBalanceCu ?? null;
      if (activeSessions.length === 0 && runningTasks.length === 0 && balance === null) {
        await orca.host.call("statusBar.update", { id: "colab-sessions", text: "Colab", icon: "zap", visible: false });
        return;
      }
      const parts = [];
      if (activeSessions.length > 0) {
        const s0 = activeSessions[0];
        const gpuLabel = s0.rateKey && s0.rateKey !== "unknown" ? s0.rateKey : "GPU";
        parts.push(activeSessions.length > 1 ? `${activeSessions.length}×${gpuLabel}` : gpuLabel);
        parts.push(`${primaryCredits?.estimatedBurnCuPerHour ?? 0} CU/h`);
      }
      if (runningTasks.length > 0) {
        parts.push(runningTasks.length === 1 ? "1 task" : `${runningTasks.length} tasks`);
      }
      if (balance !== null) {
        parts.push(`≈${Math.round(balance)} CU`);
      }
      await orca.host.call("statusBar.update", {
        id: "colab-sessions",
        text: `Colab: ${parts.join(" · ") || "Idle"}`,
        icon: "zap",
        tone: budgetState.tone,
        tooltip: "Click to open the Colab GPU (Community) for Orca panel",
        visible: true,
      });
    } catch (err) {
      orca.log(`statusBar update error: ${err?.message || err}`);
    }
  };

  const finish = async (extra = {}) => {
    const snap = withWorkspace(await dashboard.snapshot());
    orca.panels.post("colab.stateChanged", snap);
    void refreshStatusBar(snap);
    return { ok: true, ...extra, dashboard: snap };
  };

  const showPanel = () => {
    const orcaBin = locateOrcaBinary(process.env) || "orca";
    for (const key of ["vzxxbacq.colab", "local.colab"]) {
      const child = spawn(orcaBin, ["plugin", "open", key, "--panel", "colab"], { stdio: "ignore", detached: true });
      child.unref();
    }
  };

  let provisioningTicker = null;
  const setProvisioning = (state) => {
    dashboard.provisioningState = state;
    orca.panels.post("colab.provisioningProgress", state);
  };

  // Starts a runtime through the Colab API in this process; no terminal is opened anywhere.
  const startSession = async ({ gpu, account, keep }) => {
    setProvisioning({ active: true, message: `Assigning Colab ${gpu} runtime via Google Colab Direct API...`, error: null });
    orca.panels.post("colab.stateChanged", withWorkspace(await dashboard.snapshot()));
    const startMs = Date.now();
    clearInterval(provisioningTicker);
    let lastMessage = `Assigning Colab ${gpu} runtime...`;
    provisioningTicker = setInterval(() => {
      const sec = Math.floor((Date.now() - startMs) / 1000);
      setProvisioning({ active: true, message: `${lastMessage} (${sec}s elapsed)`, error: null });
    }, 2000);
    try {
      await dashboard.call("startSession", { gpu, account, keep, projectDir: localProjectDir() }, {
        onProgress: (line) => {
          lastMessage = line;
          setProvisioning({ active: true, message: line, error: null });
        },
      });
      clearInterval(provisioningTicker);
      setProvisioning({ active: false, message: null, error: null });
      return await finish({ mode: "direct-api" });
    } catch (err) {
      clearInterval(provisioningTicker);
      const msg = err instanceof Error ? err.message : String(err);
      setProvisioning({ active: false, message: null, error: msg });
      orca.panels.post("colab.stateChanged", withWorkspace(await dashboard.snapshot()));
      throw err;
    }
  };

  const signedIn = async (account) => {
    const snap = await dashboard.snapshot();
    return Boolean(snap.authByAccount?.[account || snap.defaultAccount || "default"]?.authenticated);
  };

  orca.commands.register("colab.up", async () => {
    if (!(await signedIn())) {
      await notifyUser("Sign in with Google in the Colab GPU panel first.", "warning");
      showPanel();
      return;
    }
    try {
      await startSession({ gpu: "AUTO", account: undefined, keep: false });
      await notifyUser("Colab runtime is ready.", "info");
    } catch (err) {
      await notifyUser(`Colab runtime was not started: ${err?.message || err}`, "error");
    }
  });

  orca.commands.register("colab.down", async () => {
    try {
      const res = await dashboard.call("stopSession", {});
      await finish();
      await notifyUser(
        res?.ok === false
          ? `Colab session ${res.session} was not released: it is in use from another machine, or that could not be checked. Stop it from the panel if you mean to.`
          : "Colab runtime released.",
        res?.ok === false ? "warning" : "info",
      );
    } catch (err) {
      await notifyUser(`Colab runtime was not released: ${err?.message || err}`, "error");
    }
  });

  orca.commands.register("colab.showPanel", async () => showPanel());

  // Raw host answers, for `orca plugin dev request . colab.debugWorkspace` when the badge looks wrong.
  orca.panels.handle("colab.debugWorkspace", async () => {
    const [ctx, listRes] = await Promise.all([
      orca.host.call("workspace.readContext", {}).catch((err) => ({ error: String(err?.message || err) })),
      orca.host.call("workspace.list", {}).catch((err) => ({ error: String(err?.message || err) })),
    ]);
    return {
      readContext: ctx,
      workspaceList: listRes,
      resolved: await resolveWorkspaceInfo(orca),
      runtimeSync: { at: dashboard.builder.lastRuntimeSyncAt || null, error: dashboard.builder.lastRuntimeSyncError },
      orcaCli: { bin: orcaCli.available ? orcaCli.orcaBin : null },
    };
  });

  // The panel calls this on workspace events and on its own focus.
  orca.panels.handle("colab.focusChanged", async () => {
    await resolveWorkspace({ force: true });
    return withWorkspace(await dashboard.snapshot());
  });

  orca.panels.handle("colab.dashboard", async (input = {}) => {
    lastPanelRequestAt = Date.now();
    await resolveWorkspace();
    if (input?.selectedTaskId) {
      dashboard.selectTask(String(input.selectedTaskId));
    }
    return withWorkspace(await dashboard.snapshot({ includeLiveMetrics: Boolean(input?.includeLiveMetrics) }));
  });

  orca.panels.handle("colab.sessions", async () => withWorkspace(await dashboard.snapshot({ includeLiveMetrics: true })));

  orca.panels.handle("colab.doctor", async () => (await dashboard.snapshot()).doctor);

  orca.panels.handle("colab.cliCommand", async () => ({ command: await resolveCliCommand(orca) }));

  // The skill goes into agent folders on this machine only when the user asks, from the panel.
  orca.panels.handle("colab.agentSkills", async () => inspectAgentSkills(homeDir));
  orca.panels.handle("colab.installAgentSkill", async (input = {}) => installAgentSkill(input?.targets, homeDir));
  orca.panels.handle("colab.removeAgentSkill", async (input = {}) => removeAgentSkill(input?.targets, homeDir));

  const simpleActions = PANEL_ACTION_NAMES.filter(
    (n) =>
      !["authLogin", "startSession", "submitTask", "getTaskLogs", "updateProjectGuardrails", "removeProjectGuardrails"].includes(n),
  );
  for (const name of simpleActions) {
    orca.panels.handle(`colab.${name}`, async (input = {}) => {
      const result = await dashboard.call(name, input);
      if (result?.ok === false) {
        return { ...result, dashboard: withWorkspace(await dashboard.snapshot()) };
      }
      return finish(result);
    });
  }

  // Project guardrails are a file in the project. The worker writes it only for a project on this
  // computer; the folder comes from the focused workspace, not from the panel.
  for (const name of ["updateProjectGuardrails", "removeProjectGuardrails"]) {
    orca.panels.handle(`colab.${name}`, async (input = {}) => {
      await resolveWorkspace();
      const projectDir = localProjectDir();
      if (!projectDir) {
        return {
          ok: false,
          code: "PROJECT_NOT_LOCAL",
          message: "This project's files are not on this computer, so its guardrails file cannot be changed from here. Open the file in Orca's editor instead.",
          dashboard: withWorkspace(await dashboard.snapshot()),
        };
      }
      return finish(await dashboard.call(name, { ...input, projectDir }));
    });
  }

  // For a runtime started from a project on an Orca server: its guardrails file is opened in Orca's own
  // editor, on that server. The path comes from the runtime's record; nothing is written from here.
  orca.panels.handle("colab.openGuardrailsFile", async (input = {}) => {
    const session = readSession(String(input?.session || ""), homeDir);
    const file =
      session?.guardrails?.file ||
      (session?.origin?.directory ? `${session.origin.directory.replace(/[\\/]+$/, "")}/.orca/colab.json` : null);
    if (!file) {
      return { ok: false, code: "NO_PATH", message: "This runtime's record does not say which project it was started from." };
    }
    const workspace = await resolveWorkspace();
    const recorded = session.origin?.orcaWorkspace;
    const selectors = [
      ...(recorded ? [recorded.startsWith("folder:") ? recorded : `id:${recorded}`] : []),
      ...(workspace.hostId && workspace.workspaceName ? [`name:${workspace.workspaceName}`] : []),
    ];
    if (!orcaCli.available || selectors.length === 0) {
      return { ok: false, code: "CANNOT_OPEN", file, exists: Boolean(session.guardrails?.file), attempts: [] };
    }
    const opened = await orcaCli.openFileOnServer({ file, selectors });
    return opened.ok
      ? { ok: true, file, environment: opened.environment }
      : { ok: false, code: "CANNOT_OPEN", file, exists: Boolean(session.guardrails?.file), attempts: opened.attempts };
  });

  // Sign-in happens on this machine, in the user's own browser, and stays on this machine.
  orca.panels.handle("colab.authLogin", async (input = {}) => {
    const result = await dashboard.call("authLogin", input, {
      onAuthUrl: (payload) => orca.panels.post("colab.oauthUrl", { ...payload, origin: "local" }),
    });
    return finish(result);
  });

  orca.panels.handle("colab.getTaskLogs", async (input = {}) => {
    dashboard.selectTask(String(input?.taskId || ""));
    const result = await dashboard.call("getTaskLogs", input);
    return { ok: true, ...result };
  });

  orca.panels.handle("colab.submitTask", async (input = {}) => {
    const workspace = await resolveWorkspace();
    // The worker runs on this machine, so it can only sync files that are on this machine.
    if (input?.syncWorkspace && (workspace.hostId || !workspace.workspacePath)) {
      return {
        ok: false,
        code: "WORKSPACE_NOT_LOCAL",
        message: workspace.hostId
          ? "This project's files are on a remote Orca server, so the panel cannot sync them. Have the agent there run 'orca-colab sync' (or 'job submit --sync'), then submit without sync."
          : "No local workspace is focused to sync from.",
        dashboard: withWorkspace(await dashboard.snapshot()),
      };
    }
    const result = await dashboard.call("submitTask", { ...input, workspacePath: workspace.workspacePath });
    if (result?.ok === false) {
      return { ...result, dashboard: withWorkspace(await dashboard.snapshot()) };
    }
    return finish(result);
  });

  orca.panels.handle("colab.startSession", async (input = {}) => {
    const gpu = String(input?.gpu || "T4").toUpperCase();
    const account = input?.account || undefined;
    if (!(await signedIn(account))) {
      return { ok: false, code: "NOT_SIGNED_IN", message: "Sign in with Google first." };
    }
    const current = await dashboard.snapshot();
    if (current.provisioning?.active) {
      return { ok: true, mode: "already-provisioning", dashboard: withWorkspace(current) };
    }
    const run = startSession({ gpu, account, keep: Boolean(input?.keep) });
    if (input?.async) {
      run.catch((err) => orca.log(`startSession async error: ${err?.message || err}`));
      return { ok: true, mode: "direct-api-async", dashboard: withWorkspace(await dashboard.snapshot()) };
    }
    return run;
  });

  // Shells on a runtime, held by the worker over the runtime's own Jupyter terminal websocket and shown
  // in the panel; Orca's terminals are not involved.
  const shells = new Map();
  const closeShell = async (id) => {
    const shell = shells.get(id);
    if (!shell) return;
    shells.delete(id);
    clearInterval(shell.activityTimer);
    await shell.handle.close();
  };

  orca.panels.handle("colab.shellOpen", async (input = {}) => {
    const snap = await dashboard.snapshot();
    const live = (snap.sessions || []).filter((s) => s.state !== "zombie");
    const sessionName = input?.session || live[0]?.name;
    const session = sessionName ? readSession(String(sessionName), homeDir) : null;
    if (!session?.colabRuntime?.baseUrl || !session.colabRuntime.token) {
      return { ok: false, code: "NO_ACTIVE_SESSION", message: "No active Colab runtime to open a shell on." };
    }
    const channel = createRuntimeChannel({ sessionName: session.name, homeDir });
    await channel.refreshToken().catch(() => {});
    const current = channel.session();
    const id = `shell-${Date.now().toString(36)}`;
    const origin = describeOrigin({ agent: "Orca panel shell" });
    const stamp = (running) => stampRuntimeActivity(channel, { origin, command: "shell", running }).catch(() => {});
    const handle = await openRuntimeShell({
      baseUrl: current.colabRuntime.baseUrl,
      proxyToken: current.colabRuntime.token,
      cols: Number(input?.cols) || 100,
      rows: Number(input?.rows) || 30,
      onData: (data) => orca.panels.post("colab.shellOutput", { id, data }),
      onClose: () => {
        if (shells.has(id)) {
          clearInterval(shells.get(id).activityTimer);
          shells.delete(id);
        }
        void stamp(false);
        orca.panels.post("colab.shellClosed", { id });
      },
    });
    void stamp(true);
    shells.set(id, { handle, session: session.name, activityTimer: setInterval(() => void stamp(true), 60_000) });
    return { ok: true, id, session: session.name };
  });

  orca.panels.handle("colab.shellInput", async (input = {}) => {
    const shell = shells.get(String(input?.id || ""));
    if (!shell) {
      return { ok: false, code: "SHELL_CLOSED" };
    }
    shell.handle.write(String(input?.data ?? ""));
    return { ok: true };
  });

  orca.panels.handle("colab.shellClose", async (input = {}) => {
    await closeShell(String(input?.id || ""));
    return { ok: true };
  });

  const statusInterval = setInterval(() => void refreshStatusBar(), 30_000);
  // Focus changes arrive as workspace events on hosts that emit them; panel requests cover the rest.
  for (const eventName of ["workspace.changed", "workspace.created", "workspace.removed"]) {
    try {
      const off = orca.events?.on?.(eventName, () => void resolveWorkspace({ force: true }));
      if (typeof off === "function") cleanupFns.push(off);
    } catch {
      // Event not supported on this host.
    }
  }
  cleanupFns.push(() => clearInterval(statusInterval));
  cleanupFns.push(() => clearInterval(provisioningTicker));
  cleanupFns.push(() => dashboard.stop());
  cleanupFns.push(() => {
    for (const id of [...shells.keys()]) void closeShell(id);
  });

  // Network and workspace lookups before activate() returns stall the worker's readiness handshake, so
  // the status bar is seeded from this machine's files and the first sync runs on the next tick.
  await refreshStatusBar(await dashboard.builder.build({ provisioningState: dashboard.provisioningState }));
  const kickoff = setTimeout(() => void resolveWorkspace({ force: true }).then(() => refreshStatusBar()), 0);
  cleanupFns.push(() => clearTimeout(kickoff));
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
