import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FrameAssembler } from "../bin/lib/bridge-frames.mjs";
import { getRuntime } from "../bin/lib/colab-api-client.mjs";
import { locateOrcaBinary } from "../bin/lib/colab-browser-automation.mjs";
import { ensureColabHome } from "../bin/lib/colab-home.mjs";
import { getValidAccessToken, readOAuthAccountStatus } from "../bin/lib/colab-oauth.mjs";
import { DashboardSnapshotBuilder, pickActiveTask } from "../bin/lib/dashboard-snapshot.mjs";
import {
  DEFAULT_AUTO_STOP_IDLE_MINUTES,
  evaluateBudgetAlert,
  evaluateSessionIdleState,
  GRACE_PERIOD_MINUTES,
} from "../bin/lib/idle-watchdog.mjs";
import { createPanelActions, PANEL_ACTION_NAMES } from "../bin/lib/panel-actions.mjs";
import { listSessions, readSession, writeSession } from "../bin/lib/session-store.mjs";
import { listTasks, readTaskLog } from "../bin/lib/task-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_CLI_PATH = path.resolve(__dirname, "..", "bin", "orca-colab.mjs");
const BUNDLED_SKILL_DIR = path.resolve(__dirname, "..", "skills", "colab-gpu");
const BRIDGE_TERMINAL_TITLE = "Colab Bridge";
const DEFAULT_CLI_COMMAND = "npx -y github:vzxxbacq/orca-colab#v0.1.0";
const ACTION_TIMEOUTS_MS = {
  authLogin: 320_000,
  startSession: 15 * 60_000,
  stopSession: 90_000,
  submitTask: 120_000,
  calibrateCredits: 60_000,
};

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

// Orca reports the machine it runs on as host "local" (observed on 1.4.254), not as null.
export function isRemoteHostId(hostId) {
  return typeof hostId === "string" && hostId.trim() !== "" && hostId.trim().toLowerCase() !== "local";
}

function workspaceRows(listRes) {
  return Array.isArray(listRes) ? listRes : Array.isArray(listRes?.workspaces) ? listRes.workspaces : [];
}

// readContext has no id, so the focused workspace is matched against the list by name and branch.
async function resolveWorkspaceInfo(orca) {
  try {
    const [ctx, listRes] = await Promise.all([
      orca.host.call("workspace.readContext", {}).catch(() => null),
      orca.host.call("workspace.list", {}).catch(() => null),
    ]);
    const rows = workspaceRows(listRes);
    if (rows.length === 0) {
      return { workspaceId: null, workspacePath: null, workspaceName: null, hostId: null, terminals: [] };
    }
    const matched =
      rows.find(
        (w) =>
          (ctx?.displayName && w.name === ctx.displayName) ||
          (ctx?.branch && w.branch === ctx.branch),
      ) || rows[0];
    return {
      workspaceId: matched?.id || null,
      workspacePath: matched?.path || null,
      workspaceName: matched?.name || null,
      hostId: isRemoteHostId(matched?.hostId) ? matched.hostId : null,
      terminals: Array.isArray(ctx?.terminals) ? ctx.terminals : [],
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

async function resolveCliCommand(orca, { remote = false } = {}) {
  if (remote) {
    const remoteConfigured = await readSetting(orca, "remoteCliCommand", null);
    if (typeof remoteConfigured === "string" && remoteConfigured.trim()) {
      return remoteConfigured.trim();
    }
  } else if (existsSync(LOCAL_CLI_PATH)) {
    return `node ${JSON.stringify(LOCAL_CLI_PATH)}`;
  }
  const configured = await readSetting(orca, "cliCommand", null);
  return typeof configured === "string" && configured.trim() ? configured.trim() : DEFAULT_CLI_COMMAND;
}

function taskStreamFingerprint(snap) {
  const out = snap?.activeTaskOutput;
  return out ? `${out.taskId}:${out.status}:${out.exitCode}:${out.totalBytes}` : "";
}

function listFingerprint(snap) {
  const tasks = (snap?.tasks || []).map((t) => `${t.id}:${t.status}:${t.exitCode}:${t.finishedAt || ""}`);
  const sessions = (snap?.sessions || []).map((s) => `${s.name}:${s.state}:${s.keep ? 1 : 0}`);
  return `${tasks.join("|")}#${sessions.join("|")}`;
}

// Reads ~/.orca-colab on this machine; used when the focused workspace is local.
class LocalBridge {
  constructor({ orca, homeDir, env, skillSync, notifyUser, onSnapshot }) {
    this.kind = "local";
    this.orca = orca;
    this.homeDir = homeDir;
    this.env = env;
    this.notifyUser = notifyUser;
    this.onSnapshot = onSnapshot;
    this.builder = new DashboardSnapshotBuilder({
      homeDir,
      env,
      skillSync,
      origin: { kind: "local", host: os.hostname(), platform: process.platform },
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

  describe() {
    return { connected: true };
  }

  selectTask(taskId) {
    this.selectedTaskId = taskId || null;
  }

  setLive() {}

  async snapshot({ includeLiveMetrics = false } = {}) {
    const snap = await this.builder.build({
      includeLiveMetrics,
      selectedTaskId: this.selectedTaskId,
      provisioningState: this.provisioningState,
    });
    return { ...snap, bridge: this.describe() };
  }

  async call(action, input, hooks = {}) {
    const fn = this.actions[action];
    if (typeof fn !== "function") {
      throw new Error(`unknown action: ${action}`);
    }
    const result = await fn(input, hooks);
    if (action === "authLogin" || action === "authSwitch" || action === "authLogout") {
      this.builder.invalidateDoctor();
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

  async watchdogTick() {
    const { homeDir } = this;
    const autoStopIdleMinutes = Number(
      await readSetting(this.orca, "autoStopIdleMinutes", DEFAULT_AUTO_STOP_IDLE_MINUTES),
    );
    const sessions = listSessions(homeDir).filter((s) => s.state !== "zombie");
    const tasks = listTasks(homeDir);
    for (const s of sessions) {
      if (s.colabRuntime?.id) {
        try {
          const accessToken = await getValidAccessToken({ account: s.account || "default", homeDir });
          const refreshed = accessToken
            ? await getRuntime({ runtimeId: s.colabRuntime.id, accessToken })
            : null;
          if (refreshed?.connectionInfo?.token) {
            writeSession(
              {
                ...s,
                colabRuntime: {
                  ...s.colabRuntime,
                  token: refreshed.connectionInfo.token,
                  tokenExpiry: refreshed.connectionInfo.expireTime || s.colabRuntime.tokenExpiry,
                },
              },
              homeDir,
            );
          }
        } catch {
          // Best effort; the next tick retries.
        }
      }
      if (s.ip) {
        const metrics = this.builder.liveMetricsBySession.get(s.name);
        if (metrics && typeof metrics.gpuUtilizationPercent === "number") {
          this.builder.recordGpuSample(s.name, metrics.gpuUtilizationPercent);
        }
      }
      const runningCount = tasks.filter((t) => t.sessionName === s.name && t.status === "running").length;
      const decision = evaluateSessionIdleState({
        session: s,
        gpuSamples: this.builder.gpuUtilSamplesBySession.get(s.name) || [],
        runningTasksCount: runningCount,
        autoStopIdleMinutes,
        nowMs: Date.now(),
      });
      if (decision.isIdle && !this.graceTimers.has(s.name)) {
        await this.notifyUser(
          `Colab session ${s.name} has been idle for ${Math.round(decision.idleMinutes)} min (<5% GPU). Stopping in ${GRACE_PERIOD_MINUTES} min unless used or marked Keep.`,
          "warning",
        );
        const timer = setTimeout(async () => {
          this.graceTimers.delete(s.name);
          const latest = readSession(s.name, homeDir);
          const latestRunning = listTasks(homeDir).filter(
            (t) => t.sessionName === s.name && t.status === "running",
          ).length;
          const recheck = evaluateSessionIdleState({
            session: latest,
            gpuSamples: this.builder.gpuUtilSamplesBySession.get(s.name) || [],
            runningTasksCount: latestRunning,
            autoStopIdleMinutes,
            nowMs: Date.now(),
          });
          if (recheck.isIdle) {
            await this.actions.stopSession({ session: s.name, cause: "idle-watchdog" }).catch(() => {});
            await this.notifyUser(`Auto-stopped idle Colab session ${s.name} to save compute units.`, "info");
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

// Drives `orca-colab watch` inside one terminal of a workspace on a remote Orca server. The terminal is
// the only channel Orca gives a desktop plugin to a remote host, so state arrives as frames read back
// from the screen and actions are typed in as control lines.
class TerminalBridge {
  constructor({ orca, workspace, remoteCli, autoStopIdleMinutes, onSnapshot, onEvent }) {
    this.kind = "remote";
    this.orca = orca;
    this.workspace = workspace;
    this.remoteCli = remoteCli;
    this.autoStopIdleMinutes = autoStopIdleMinutes;
    this.onSnapshot = onSnapshot;
    this.onEvent = onEvent;
    this.terminalId = null;
    this.assembler = new FrameAssembler();
    this.pending = new Map();
    this.latestSnap = null;
    this.lastFrameAt = 0;
    this.lastCreateAt = 0;
    this.lastError = null;
    this.reqCounter = 0;
    this.timers = [];
    this.lastStreamFp = "";
    this.storageKey = `bridgeTerminal:${workspace.workspaceId}`;
  }

  describe() {
    return {
      connected: Boolean(this.terminalId) && Date.now() - this.lastFrameAt < 45_000,
      terminalId: this.terminalId,
      lastFrameAt: this.lastFrameAt || null,
      error: this.lastError,
      remoteCli: this.remoteCli,
    };
  }

  start() {
    this.timers.push(setInterval(() => void this.poll(), 1500));
    void this.poll();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Bridge stopped."));
    }
    this.pending.clear();
  }

  async rememberTerminal(id) {
    this.terminalId = id;
    try {
      await this.orca.storage?.set?.(this.storageKey, id);
    } catch {
      // Storage is a convenience to survive worker restarts.
    }
  }

  async ensureTerminal() {
    if (this.terminalId) {
      return this.terminalId;
    }
    try {
      const stored = await this.orca.storage?.get?.(this.storageKey);
      if (typeof stored === "string" && stored) {
        const probe = await this.orca.host.call("terminal.read", { terminalId: stored, maxLines: 5 });
        if (probe && Array.isArray(probe.lines)) {
          this.terminalId = stored;
          this.sendRaw("snap");
          return stored;
        }
      }
    } catch {
      // Stored terminal is gone; fall through to create a new one.
    }
    const existing = (this.workspace.terminals || []).find((t) => t.title === BRIDGE_TERMINAL_TITLE);
    if (existing?.id) {
      await this.rememberTerminal(existing.id);
      this.sendRaw("snap");
      return existing.id;
    }
    if (Date.now() - this.lastCreateAt < 30_000) {
      return null;
    }
    this.lastCreateAt = Date.now();
    const res = await this.orca.host.call("terminal.create", {
      workspaceId: this.workspace.workspaceId,
      title: BRIDGE_TERMINAL_TITLE,
      command: `${this.remoteCli} watch --auto-stop-idle-minutes ${this.autoStopIdleMinutes}`,
    });
    if (!res?.terminalId) {
      throw new Error("terminal.create returned no terminalId");
    }
    await this.rememberTerminal(res.terminalId);
    return res.terminalId;
  }

  async resolveSendMethod() {
    if (this.sendMethod) {
      return this.sendMethod;
    }
    // Older hosts only know the terminal.sendText spelling.
    for (const name of ["terminal.send", "terminal.sendText"]) {
      if (await this.orca.host.has(name).catch(() => false)) {
        this.sendMethod = name;
        return name;
      }
    }
    this.sendMethod = "terminal.send";
    return this.sendMethod;
  }

  sendRaw(text) {
    if (!this.terminalId) {
      return;
    }
    void this.resolveSendMethod().then((method) =>
      this.orca.host.call(method, { terminalId: this.terminalId, text, enter: true }).catch((err) => {
        this.lastError = `${method}: ${err?.message || err}`;
      }),
    );
  }

  async poll() {
    try {
      const terminalId = await this.ensureTerminal();
      if (!terminalId) {
        return;
      }
      const res = await this.orca.host.call("terminal.read", { terminalId, maxLines: 2000 });
      if (!res || !Array.isArray(res.lines)) {
        throw new Error("terminal.read returned no lines");
      }
      for (const frame of this.assembler.ingest(res.lines.join("\n"))) {
        this.lastFrameAt = Date.now();
        this.lastError = null;
        this.handleFrame(frame);
      }
      if (this.lastFrameAt && Date.now() - this.lastFrameAt > 90_000) {
        // The watch process died or the terminal was closed; start over with a fresh one.
        this.terminalId = null;
        this.lastFrameAt = 0;
      }
    } catch (err) {
      this.lastError = err?.message || String(err);
      this.terminalId = null;
    }
  }

  handleFrame({ kind, payload }) {
    if (kind === "snap") {
      this.latestSnap = payload;
      this.onSnapshot(this.decorate(payload), { stateChanged: true });
      const out = payload.activeTaskOutput;
      const fp = taskStreamFingerprint(payload);
      if (out && fp !== this.lastStreamFp) {
        this.lastStreamFp = fp;
        const task = (payload.tasks || []).find((t) => t.id === out.taskId) || { id: out.taskId, status: out.status };
        this.onSnapshot(null, {
          taskOutput: { task, output: out.output, totalBytes: out.totalBytes, truncated: out.truncated },
        });
      }
      return;
    }
    if (kind === "res") {
      const entry = this.pending.get(payload.reqId);
      if (!entry) {
        return;
      }
      this.pending.delete(payload.reqId);
      clearTimeout(entry.timer);
      if (payload.ok) {
        entry.resolve(payload.result ?? {});
      } else {
        entry.reject(new Error(payload.error || "remote action failed"));
      }
      return;
    }
    if (kind === "evt") {
      this.onEvent(payload.name, payload.payload, this);
    }
  }

  decorate(snap) {
    return {
      ...snap,
      origin: {
        ...(snap.origin || { kind: "remote" }),
        hostId: this.workspace.hostId,
        workspaceName: this.workspace.workspaceName,
      },
      bridge: this.describe(),
    };
  }

  selectTask(taskId) {
    this.sendRaw(`select ${taskId || ""}`.trim());
  }

  setLive(on) {
    this.sendRaw(`live ${on ? 1 : 0}`);
  }

  async snapshot() {
    if (this.latestSnap) {
      return this.decorate(this.latestSnap);
    }
    await this.ensureTerminal().catch(() => null);
    const deadline = Date.now() + 12_000;
    while (!this.latestSnap && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      await this.poll();
    }
    if (this.latestSnap) {
      return this.decorate(this.latestSnap);
    }
    return {
      origin: { kind: "remote", hostId: this.workspace.hostId, workspaceName: this.workspace.workspaceName },
      bridge: this.describe(),
      doctor: { ok: false, checks: {}, actions: [], warnings: [] },
      auth: { authenticated: false },
      authByAccount: {},
      accounts: [],
      oauthAccounts: [],
      sessions: [],
      tasks: [],
      credits: null,
      creditsByAccount: {},
      provisioning: { active: false, message: null, error: null },
      policy: { allowedGpus: [], maxConcurrentSessions: 1 },
      activeTaskOutput: null,
      rates: null,
    };
  }

  async call(action, input, hooks = {}) {
    const terminalId = await this.ensureTerminal();
    if (!terminalId) {
      throw new Error(this.lastError || "Colab bridge terminal is not available yet; try again in a moment.");
    }
    this.reqCounter += 1;
    const reqId = `r${Date.now().toString(36)}${this.reqCounter}`;
    const b64 = Buffer.from(JSON.stringify(input ?? {}), "utf8").toString("base64");
    const timeoutMs = hooks.timeoutMs || ACTION_TIMEOUTS_MS[action] || 45_000;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`Timed out waiting for the remote ${action} to finish.`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer, hooks });
    });
    this.sendRaw(`call ${reqId} ${action} ${b64}`);
    return promise;
  }
}

export default async function activate(orca, { homeDir = os.homedir() } = {}) {
  const paths = ensureColabHome(homeDir);
  const skillSync = syncBundledSkillToAgentDirs(homeDir);
  const budgetNotifiedKeys = {};
  const remoteBridges = new Map();
  let activeBridge = null;
  let lastResolveAt = 0;
  let lastResolvedKey = "";
  let resolvedWorkspace = null;

  const notifyUser = async (message, tone = "info") => {
    try {
      if (await orca.host.has("notifications.show")) {
        await orca.host.call("notifications.show", { title: "Google Colab GPU", message, tone });
      }
    } catch {
      // Notifications are optional.
    }
  };

  const postFromBridge = (bridge) => (snap, { stateChanged = false, taskOutput = null } = {}) => {
    if (bridge !== activeBridge) {
      return;
    }
    if (stateChanged && snap) {
      orca.panels.post("colab.stateChanged", snap);
      void refreshStatusBar(snap);
    }
    if (taskOutput) {
      orca.panels.post("colab.taskOutput", taskOutput);
    }
  };

  const onRemoteEvent = (name, payload, bridge) => {
    if (bridge !== activeBridge) {
      return;
    }
    if (name === "oauthUrl") {
      orca.panels.post("colab.oauthUrl", { ...payload, manual: true, origin: "remote" });
    } else if (name === "provisioningProgress") {
      orca.panels.post("colab.provisioningProgress", payload);
    } else if (name === "notify") {
      void notifyUser(payload?.message || "", payload?.tone || "info");
    }
  };

  const localBridge = new LocalBridge({
    orca,
    homeDir,
    env: process.env,
    skillSync,
    notifyUser,
    onSnapshot: (snap, meta) => postFromBridge(localBridge)(snap, meta),
  });
  localBridge.start(paths);
  activeBridge = localBridge;

  // Which bridge serves the panel follows the focused workspace: a `hostId` means the workspace, its
  // terminals and its ~/.orca-colab live on a remote Orca server.
  const resolveBridge = async ({ force = false } = {}) => {
    if (!force && Date.now() - lastResolveAt < 4000) {
      return activeBridge;
    }
    lastResolveAt = Date.now();
    const info = await resolveWorkspaceInfo(orca);
    const key = `${info.workspaceId}|${info.hostId}|${info.workspaceName}`;
    if (key !== lastResolvedKey) {
      lastResolvedKey = key;
      orca.log(`focused workspace: ${info.workspaceName || "?"} id=${info.workspaceId || "?"} hostId=${info.hostId || "local"} path=${info.workspacePath || "?"}`);
    }
    resolvedWorkspace = info;
    if (!info.hostId || !info.workspaceId) {
      if (activeBridge !== localBridge) {
        activeBridge = localBridge;
        orca.panels.post("colab.stateChanged", await localBridge.snapshot());
      }
      return localBridge;
    }
    let bridge = remoteBridges.get(info.workspaceId);
    if (!bridge) {
      const remoteCli = await resolveCliCommand(orca, { remote: true });
      const autoStopIdleMinutes = Number(
        await readSetting(orca, "autoStopIdleMinutes", DEFAULT_AUTO_STOP_IDLE_MINUTES),
      );
      bridge = new TerminalBridge({
        orca,
        workspace: info,
        remoteCli,
        autoStopIdleMinutes,
        onSnapshot: (snap, meta) => postFromBridge(bridge)(snap, meta),
        onEvent: onRemoteEvent,
      });
      remoteBridges.set(info.workspaceId, bridge);
      bridge.start();
    } else {
      bridge.workspace = info;
    }
    if (activeBridge !== bridge) {
      activeBridge = bridge;
      if (bridge.latestSnap) {
        orca.panels.post("colab.stateChanged", bridge.decorate(bridge.latestSnap));
      }
    }
    return bridge;
  };

  const refreshStatusBar = async (snapInput = null) => {
    try {
      const snap = snapInput || (await (await resolveBridge()).snapshot());
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
      const prefix = snap.origin?.kind === "remote" ? "Colab@server" : "Colab";
      await orca.host.call("statusBar.update", {
        id: "colab-sessions",
        text: `${prefix}: ${parts.join(" · ") || "Idle"}`,
        icon: "zap",
        tone: budgetState.tone,
        tooltip:
          snap.origin?.kind === "remote"
            ? `Colab state of ${snap.origin.workspaceName || "remote workspace"} on its Orca server`
            : "Click to open Google Colab GPU & Task Manager panel",
        visible: true,
      });
    } catch (err) {
      orca.log(`statusBar update error: ${err?.message || err}`);
    }
  };

  const finish = async (bridge, extra = {}) => {
    const snap = await bridge.snapshot();
    orca.panels.post("colab.stateChanged", snap);
    void refreshStatusBar(snap);
    return { ok: true, ...extra, dashboard: snap };
  };

  orca.commands.register("colab.up", async () => {
    const bridge = await resolveBridge({ force: true });
    const cli = await resolveCliCommand(orca, { remote: bridge.kind === "remote" });
    await openTerminalWithCommand({ title: "Colab: Start GPU", command: `${cli} up` });
  });

  orca.commands.register("colab.down", async () => {
    const bridge = await resolveBridge({ force: true });
    const cli = await resolveCliCommand(orca, { remote: bridge.kind === "remote" });
    await openTerminalWithCommand({ title: "Colab: Stop GPU", command: `${cli} down` });
  });

  orca.commands.register("colab.showPanel", async () => {
    const orcaBin = locateOrcaBinary(process.env) || "orca";
    for (const key of ["vzxxbacq.colab", "local.colab"]) {
      const child = spawn(orcaBin, ["plugin", "open", key, "--panel", "colab"], { stdio: "ignore", detached: true });
      child.unref();
    }
  });

  // Terminals always open in the focused workspace, which is exactly where the matching CLI lives.
  const openTerminalWithCommand = async ({ title, command }) => {
    const info = resolvedWorkspace?.workspaceId ? resolvedWorkspace : await resolveWorkspaceInfo(orca);
    if (!info.workspaceId) {
      throw new Error("No active Orca workspace found to open a terminal.");
    }
    return orca.host.call("terminal.create", { workspaceId: info.workspaceId, title: title || "Colab GPU", command });
  };

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
      activeBridge: activeBridge?.kind || null,
      hostHas: {
        terminalSend: await orca.host.has("terminal.send").catch(() => null),
        terminalSendText: await orca.host.has("terminal.sendText").catch(() => null),
        terminalRead: await orca.host.has("terminal.read").catch(() => null),
      },
    };
  });

  orca.panels.handle("colab.dashboard", async (input = {}) => {
    const bridge = await resolveBridge();
    if (input?.selectedTaskId) {
      bridge.selectTask(String(input.selectedTaskId));
    }
    bridge.setLive(Boolean(input?.includeLiveMetrics));
    return bridge.snapshot({ includeLiveMetrics: Boolean(input?.includeLiveMetrics) });
  });

  orca.panels.handle("colab.sessions", async () => {
    const bridge = await resolveBridge();
    return bridge.snapshot({ includeLiveMetrics: true });
  });

  orca.panels.handle("colab.doctor", async () => {
    const bridge = await resolveBridge();
    return (await bridge.snapshot()).doctor;
  });

  const simpleActions = PANEL_ACTION_NAMES.filter(
    (n) => !["authLogin", "startSession", "submitTask", "getTaskLogs", "oauthReplay"].includes(n),
  );
  for (const name of simpleActions) {
    orca.panels.handle(`colab.${name}`, async (input = {}) => {
      const bridge = await resolveBridge();
      const result = await bridge.call(name, input);
      const out = await finish(bridge, result);
      if (name === "setupConfig") {
        out.doctor = out.dashboard.doctor;
      }
      return out;
    });
  }

  orca.panels.handle("colab.authLogin", async (input = {}) => {
    const bridge = await resolveBridge({ force: true });
    const result = await bridge.call(
      "authLogin",
      { ...input, noBrowser: bridge.kind === "remote" || Boolean(input?.noBrowser) },
      {
        timeoutMs: ACTION_TIMEOUTS_MS.authLogin,
        onAuthUrl: (payload) => orca.panels.post("colab.oauthUrl", { ...payload, origin: "local" }),
      },
    );
    return finish(bridge, result);
  });

  orca.panels.handle("colab.oauthReplay", async (input = {}) => {
    const bridge = await resolveBridge();
    const result = await bridge.call("oauthReplay", input);
    return { ok: true, ...result };
  });

  orca.panels.handle("colab.getTaskLogs", async (input = {}) => {
    const bridge = await resolveBridge();
    bridge.selectTask(String(input?.taskId || ""));
    const result = await bridge.call("getTaskLogs", input);
    return { ok: true, ...result };
  });

  orca.panels.handle("colab.submitTask", async (input = {}) => {
    const bridge = await resolveBridge();
    const workspacePath = resolvedWorkspace?.workspacePath || null;
    const result = await bridge.call("submitTask", { ...input, workspacePath });
    if (result?.ok === false) {
      return { ...result, dashboard: await bridge.snapshot() };
    }
    return finish(bridge, result);
  });

  let provisioningTicker = null;
  orca.panels.handle("colab.startSession", async (input = {}) => {
    const bridge = await resolveBridge({ force: true });
    const gpu = String(input?.gpu || "T4").toUpperCase();
    const account = input?.account || undefined;
    const useTerminal = Boolean(input?.useTerminal);
    const runAsync = Boolean(input?.async);

    const current = await bridge.snapshot();
    const authenticated = Boolean(
      current.authByAccount?.[account || current.defaultAccount || "default"]?.authenticated ??
        (bridge.kind === "local" ? readOAuthAccountStatus(account || "default", homeDir).authenticated : false),
    );
    if (useTerminal || !authenticated) {
      const cli = await resolveCliCommand(orca, { remote: bridge.kind === "remote" });
      const flags = [`--gpu ${gpu}`];
      if (account) flags.push(`--account ${account}`);
      if (input?.keep) flags.push("--keep");
      await openTerminalWithCommand({ title: `Colab: Start ${gpu}`, command: `${cli} up ${flags.join(" ")}` });
      return { ok: true, mode: "terminal" };
    }
    if (current.provisioning?.active) {
      return { ok: true, mode: "already-provisioning", dashboard: current };
    }

    const setProvisioning = (state) => {
      if (bridge.kind === "local") {
        bridge.provisioningState = state;
      }
      orca.panels.post("colab.provisioningProgress", state);
    };
    setProvisioning({ active: true, message: `Assigning Colab ${gpu} runtime via Google Colab Direct API...`, error: null });
    orca.panels.post("colab.stateChanged", await bridge.snapshot());
    const startMs = Date.now();
    clearInterval(provisioningTicker);
    let lastMessage = `Assigning Colab ${gpu} runtime...`;
    provisioningTicker = setInterval(() => {
      const sec = Math.floor((Date.now() - startMs) / 1000);
      setProvisioning({ active: true, message: `${lastMessage} (${sec}s elapsed)`, error: null });
    }, 2000);

    const execute = async () => {
      try {
        await bridge.call("startSession", { gpu, account, keep: Boolean(input?.keep) }, {
          timeoutMs: ACTION_TIMEOUTS_MS.startSession,
          onProgress: (line) => {
            lastMessage = line;
            setProvisioning({ active: true, message: line, error: null });
          },
        });
        clearInterval(provisioningTicker);
        setProvisioning({ active: false, message: null, error: null });
        const out = await finish(bridge, { mode: "direct-api" });
        return out;
      } catch (err) {
        clearInterval(provisioningTicker);
        const msg = err instanceof Error ? err.message : String(err);
        setProvisioning({ active: false, message: null, error: msg });
        orca.panels.post("colab.stateChanged", await bridge.snapshot());
        throw err;
      }
    };
    if (runAsync) {
      execute().catch((err) => orca.log(`startSession async error: ${err?.message || err}`));
      return { ok: true, mode: "direct-api-async", dashboard: await bridge.snapshot() };
    }
    return execute();
  });

  orca.panels.handle("colab.openTerminal", async (input = {}) => {
    const bridge = await resolveBridge({ force: true });
    const snap = await bridge.snapshot();
    const activeSessions = (snap.sessions || []).filter((s) => s.state !== "zombie");
    if (!input?.command && activeSessions.length === 0) {
      return {
        ok: false,
        code: "NO_ACTIVE_SESSION",
        message: "No active Colab GPU runtime. Launch a GPU session first to open an SSH shell.",
      };
    }
    const targetSession = input?.session || activeSessions[0]?.name;
    const cli = await resolveCliCommand(orca, { remote: bridge.kind === "remote" });
    const cmd = targetSession ? `${cli} run --session ${targetSession} -- bash -l` : input?.command || `${cli} status`;
    await openTerminalWithCommand({
      title: input?.title || (targetSession ? `SSH: ${targetSession}` : "Colab Shell"),
      command: cmd,
    });
    return { ok: true };
  });

  const statusInterval = setInterval(() => void refreshStatusBar(), 30_000);
  const bridgeInterval = setInterval(() => void resolveBridge(), 5000);
  cleanupFns.push(() => clearInterval(statusInterval));
  cleanupFns.push(() => clearInterval(bridgeInterval));
  cleanupFns.push(() => clearInterval(provisioningTicker));
  cleanupFns.push(() => localBridge.stop());
  cleanupFns.push(() => {
    for (const b of remoteBridges.values()) b.stop();
    remoteBridges.clear();
  });

  // Workspace lookups before activate() returns stall the worker's readiness handshake, so the first
  // one runs on the next tick; the status bar is seeded from local state right away.
  await refreshStatusBar(await localBridge.snapshot());
  const kickoff = setTimeout(() => void resolveBridge({ force: true }).then(() => refreshStatusBar()), 0);
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
