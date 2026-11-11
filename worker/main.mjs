import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FrameAssembler } from "../bin/lib/bridge-frames.mjs";
import { sealForRecipient } from "../bin/lib/credential-envelope.mjs";
import { getRuntime } from "../bin/lib/colab-api-client.mjs";
import { locateOrcaBinary } from "../bin/lib/colab-browser-automation.mjs";
import { ensureColabHome } from "../bin/lib/colab-home.mjs";
import { getValidAccessToken, readOAuthAccountStatus, runLoopbackOAuthFlow } from "../bin/lib/colab-oauth.mjs";
import { recordSessionEndEvent, resolveDeadSessionEndIso } from "../bin/lib/credit-ledger.mjs";
import { DashboardSnapshotBuilder, pickActiveTask } from "../bin/lib/dashboard-snapshot.mjs";
import {
  DEFAULT_AUTO_STOP_IDLE_MINUTES,
  evaluateBudgetAlert,
  evaluateSessionIdleState,
  GRACE_PERIOD_MINUTES,
} from "../bin/lib/idle-watchdog.mjs";
import { createPanelActions, PANEL_ACTION_NAMES } from "../bin/lib/panel-actions.mjs";
import { deleteSession, listSessions, readSession, writeSession } from "../bin/lib/session-store.mjs";
import { createOrcaRemoteHelper } from "../bin/lib/orca-remote-helper.mjs";
import { listTasks, readTaskLog } from "../bin/lib/task-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_CLI_PATH = path.resolve(__dirname, "..", "bin", "orca-colab.mjs");
const BUNDLED_SKILL_DIR = path.resolve(__dirname, "..", "skills", "colab-gpu");
const BRIDGE_TERMINAL_TITLE = "Colab Bridge";
const isBridgeTitle = (title) => typeof title === "string" && title.startsWith(BRIDGE_TERMINAL_TITLE);
const DEFAULT_CLI_COMMAND = "npx -y github:vzxxbacq/orca-colab#v0.2.4";
const DEFAULT_REMOTE_CLI_COMMAND = DEFAULT_CLI_COMMAND;
const WATCH_UNSUPPORTED_RE = /unknown command: watch/;
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

// readContext only gives a display name and a branch; a row matches when both agree (branch may be
// missing on folder workspaces). Archived rows lose to live ones.
export function pickWorktreeRow(rows, { workspaceName, branch }) {
  const live = rows.filter((r) => !r.isArchived);
  const byName = live.filter((r) => r.displayName === workspaceName);
  if (byName.length === 0) return null;
  if (branch) {
    const exact = byName.find((r) => r.branch === branch);
    if (exact) return exact;
    const byBranch = live.find((r) => r.branch === branch);
    if (byBranch) return byBranch;
  }
  return byName.length === 1 ? byName[0] : null;
}

// Actions whose outcome is fully determined by their input: the panel shows them at once and the
// server confirms in the next batch. Everything else waits for the server's answer.
export const OPTIMISTIC_ACTIONS = new Set([
  "updatePolicy",
  "setBudget",
  "setCredits",
  "toggleKeep",
  "clearFinishedTasks",
  "authSwitch",
]);
const FLUSH_INTERVAL_MS = 2000;

function coalesceKey(op) {
  switch (op.action) {
    case "updatePolicy":
    case "authSwitch":
      return op.action;
    case "setBudget":
    case "setCredits":
      return `${op.action}:${op.input?.account || ""}`;
    case "toggleKeep":
      return `toggleKeep:${op.input?.session || ""}`;
    case "clearFinishedTasks":
      return `clearFinishedTasks:${op.input?.sessionName || ""}`;
    default:
      return null;
  }
}

// Folds a new op into the queue: a later value of the same setting replaces the earlier one (which
// resolves as superseded) and two toggles of the same flag cancel out.
export function coalesceOps(queue, op) {
  const key = coalesceKey(op);
  if (!key) {
    return [...queue, op];
  }
  const idx = queue.findIndex((q) => coalesceKey(q) === key);
  if (idx === -1) {
    return [...queue, op];
  }
  const prev = queue[idx];
  const rest = queue.filter((_, i) => i !== idx);
  if (op.action === "toggleKeep") {
    prev.resolve?.({ superseded: true });
    op.resolve?.({ superseded: true });
    return rest;
  }
  prev.resolve?.({ superseded: true });
  return [...rest, op];
}

export function applyOptimisticOps(snapshot, ops) {
  if (!ops.length) {
    return snapshot;
  }
  const snap = structuredClone(snapshot);
  for (const { action, input = {} } of ops) {
    if (action === "updatePolicy") {
      snap.policy = {
        ...snap.policy,
        allowedGpus: Array.isArray(input.allowedGpus) && input.allowedGpus.length ? input.allowedGpus.map((g) => String(g).toUpperCase()) : snap.policy?.allowedGpus,
        maxConcurrentSessions:
          typeof input.maxConcurrentSessions === "number" ? Math.floor(input.maxConcurrentSessions) : snap.policy?.maxConcurrentSessions,
      };
    } else if (action === "setBudget" || action === "setCredits") {
      const field = action === "setBudget" ? "budgetCu" : "estimatedBalanceCu";
      const value = Number(action === "setBudget" ? input.budgetCu : input.balanceCu);
      const account = input.account || snap.defaultAccount;
      if (snap.credits && (!input.account || input.account === snap.defaultAccount)) {
        snap.credits = { ...snap.credits, [field]: value };
      }
      if (snap.creditsByAccount?.[account]) {
        snap.creditsByAccount[account] = { ...snap.creditsByAccount[account], [field]: value };
      }
    } else if (action === "toggleKeep") {
      snap.sessions = (snap.sessions || []).map((x) => (x.name === input.session ? { ...x, keep: !x.keep } : x));
    } else if (action === "clearFinishedTasks") {
      snap.tasks = (snap.tasks || []).filter(
        (t) => t.status === "running" || (input.sessionName && t.sessionName !== input.sessionName),
      );
    } else if (action === "authSwitch" && input.account) {
      snap.defaultAccount = input.account;
      snap.auth = snap.authByAccount?.[input.account] || snap.auth;
      snap.credits = snap.creditsByAccount?.[input.account] || snap.credits;
    }
  }
  return snap;
}

// Orca reports the machine it runs on as host "local" (observed on 1.4.254), not as null.
export function isRemoteHostId(hostId) {
  return typeof hostId === "string" && hostId.trim() !== "" && hostId.trim().toLowerCase() !== "local";
}

// host.has is synchronous on real Orca and async in tests.
async function hostHas(orca, method) {
  try {
    return Boolean(await orca.host.has(method));
  } catch {
    return false;
  }
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

async function resolveCliCommand(orca, { remote = false } = {}) {
  if (remote) {
    const remoteConfigured = await readSetting(orca, "remoteCliCommand", null);
    if (typeof remoteConfigured === "string" && remoteConfigured.trim()) {
      return remoteConfigured.trim();
    }
    const configured = await readSetting(orca, "cliCommand", null);
    const usable = typeof configured === "string" && configured.trim() && configured.trim() !== DEFAULT_CLI_COMMAND;
    return usable ? configured.trim() : DEFAULT_REMOTE_CLI_COMMAND;
  }
  if (existsSync(LOCAL_CLI_PATH)) {
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
        } catch (err) {
          if (err?.status === 404 && !s.ip) {
            deleteSession(s.name, homeDir);
            recordSessionEndEvent(s, {
              cause: "colab-died",
              endedAt: resolveDeadSessionEndIso(s, Date.now()),
              homeDir,
            });
            this.onSnapshot(await this.snapshot(), { stateChanged: true });
            continue;
          }
        }
      }
      const metrics = this.builder.liveMetricsBySession.get(s.name);
      if (metrics && typeof metrics.gpuUtilizationPercent === "number") {
        this.builder.recordGpuSample(s.name, metrics.gpuUtilizationPercent);
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
  constructor({
    orca,
    workspace,
    remoteCli,
    autoStopIdleMinutes,
    onSnapshot,
    onEvent,
    helper = null,
    onEnvironmentResolved = null,
    worktreeRowsCache = new Map(),
  }) {
    this.kind = "remote";
    this.onEnvironmentResolved = onEnvironmentResolved;
    this.worktreeRowsCache = worktreeRowsCache;
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
    this.helper = helper;
    this.transport = "host";
    this.lastHelperError = null;
    this.deadTerminals = new Set();
    this.watchUnsupported = false;
    this.environment = null;
    this.environmentName = null;
    this.environmentResolved = false;
    this.autoBridge = true;
    this.queue = [];
    this.inFlight = new Map();
    this.flushTimer = null;
    this.lastFlushAt = 0;
    this.controlPending = {};
    this.isPanelActive = () => true;
    this.storageKey = `bridgeTerminal:${workspace.workspaceId || `name:${workspace.workspaceName}`}`;
  }

  get canCreateTerminal() {
    return Boolean(this.workspace.workspaceId);
  }

  get manualCommand() {
    return `${this.remoteCli} watch --auto-stop-idle-minutes ${this.autoStopIdleMinutes}`;
  }

  get terminalTitle() {
    return this.environmentName ? `${BRIDGE_TERMINAL_TITLE} · ${this.environmentName}` : BRIDGE_TERMINAL_TITLE;
  }

  describe() {
    const connected = Boolean(this.terminalId) && Date.now() - this.lastFrameAt < 45_000;
    return {
      connected,
      terminalId: this.terminalId,
      lastFrameAt: this.lastFrameAt || null,
      error: this.lastError,
      remoteCli: this.remoteCli,
      needsManualTerminal: !connected && (!this.autoBridge || (!this.canCreateTerminal && !this.helperCanCreate)),
      manualCommand: this.manualCommand,
      autoBridge: this.autoBridge,
      transport: this.transport,
      pendingOps: this.queue.length + this.inFlightOps().length + this.pending.size,
      remoteProtocol: this.remoteProtocol || null,
      outdatedWatch: Boolean(this.latestSnap) && (this.remoteProtocol || 1) < 2,
      lastCliMs: this.helper?.recentTimings?.().at(-1)?.ms ?? null,
      helper: this.helper
        ? {
            available: this.helper.available,
            error: this.lastHelperError,
            environment: this.environmentName,
            worktree: this.worktreeSelector || null,
            attempts: this.environmentAttempts || [],
          }
        : { available: false, error: "no helper" },
    };
  }

  get helperCanCreate() {
    return Boolean(this.helper?.available) && !this.lastHelperError;
  }

  markWatchUnsupported() {
    this.watchUnsupported = true;
    this.lastHelperError = `The orca-colab on the server ("${this.remoteCli}") has no 'watch' command. Set the plugin setting "orca-colab command on remote Orca servers" to a newer orca-colab (for a checkout: node /path/to/orca-colab/bin/orca-colab.mjs) and reopen the panel`;
    this.terminalId = null;
  }

  // Where the host API cannot see the workspace, the local `orca` CLI still can. It finds a terminal
  // that already prints frames or creates one running `watch`; errors are kept for the panel hint.
  // The client's orca CLI only sees its own Orca unless told which paired server to talk to, so the
  // focused workspace (name + branch from readContext) is looked up in each saved environment's
  // worktree list; the match gives an exact `id:` selector, which `name:` cannot when names repeat.
  async resolveEnvironment() {
    if (this.environmentResolved) {
      return this.environment;
    }
    if (this.environmentResolving) {
      return this.environmentResolving;
    }
    if (Date.now() - (this.lastEnvironmentAttemptAt || 0) < 30_000) {
      return null;
    }
    this.lastEnvironmentAttemptAt = Date.now();
    this.environmentResolving = (async () => {
      this.environmentAttempts = [];
      // The CLI's own Orca first: on the server itself, or on a laptop whose host API simply omitted
      // the row, the workspace may be local after all.
      const localList = await this.cachedWorktrees(null);
      const localMatch = localList.ok ? pickWorktreeRow(localList.data, this.workspace) : null;
      this.environmentAttempts.push({
        environment: null,
        ok: localList.ok,
        error: localList.error,
        rows: localList.ok ? localList.data.length : 0,
        matched: localMatch?.id || null,
      });
      if (localMatch) {
        this.environment = null;
        this.environmentName = null;
        this.worktreeSelector = `id:${localMatch.id}`;
        this.environmentResolved = true;
        this.lastHelperError = null;
        return null;
      }
      const envs = await this.helper.listEnvironments();
      if (!envs.ok) {
        this.lastHelperError = envs.error;
        return null;
      }
      for (const env of envs.data) {
        const envSelector = env.id || env.name;
        const listed = await this.cachedWorktrees(envSelector);
        const match = listed.ok ? pickWorktreeRow(listed.data, this.workspace) : null;
        this.environmentAttempts.push({
          environment: env.name || envSelector,
          ok: listed.ok,
          error: listed.error,
          rows: listed.ok ? listed.data.length : 0,
          matched: match?.id || null,
        });
        if (match) {
          this.environment = envSelector;
          this.environmentName = env.name || envSelector;
          this.worktreeSelector = `id:${match.id}`;
          this.environmentResolved = true;
          this.lastHelperError = null;
          this.onEnvironmentResolved?.(envSelector, this);
          return envSelector;
        }
      }
      const lastErr = this.environmentAttempts.filter((a) => a.error).at(-1)?.error || "";
      this.lastHelperError = `none of ${envs.data.length} saved environments has a workspace named "${this.workspace.workspaceName}"${this.workspace.branch ? ` on branch ${this.workspace.branch}` : ""}${lastErr ? `; last error: ${lastErr}` : ""}`;
      return null;
    })().finally(() => {
      this.environmentResolving = null;
    });
    return this.environmentResolving;
  }

  // Worktree lists per environment are shared by every bridge and refreshed every minute, so a second
  // project on the same server resolves without another round trip to it.
  async cachedWorktrees(environment) {
    const key = environment || "local";
    const hit = this.worktreeRowsCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) {
      return hit.result;
    }
    const result = await this.helper.listWorktrees(environment ? { environment } : {});
    if (result.ok) {
      this.worktreeRowsCache.set(key, { at: Date.now(), result });
    }
    return result;
  }

  workspaceSelectors() {
    if (this.worktreeSelector) return [this.worktreeSelector];
    const out = [];
    if (this.workspace.workspaceName) out.push(`name:${this.workspace.workspaceName}`);
    if (this.workspace.branch) out.push(`branch:${this.workspace.branch}`);
    return out;
  }

  async ensureTerminalViaHelper() {
    if (!this.helper?.available) {
      this.lastHelperError = "orca CLI not found on this machine";
      return null;
    }
    const environment = await this.resolveEnvironment();
    if (!this.environmentResolved) {
      return null;
    }
    // One bridge per server: adopt a bridge terminal anywhere on it before creating another.
    const serverWide = await this.helper.listTerminals(undefined, { environment });
    if (serverWide.ok) {
      for (const t of serverWide.data) {
        if (this.deadTerminals.has(t.handle)) continue;
        if (WATCH_UNSUPPORTED_RE.test(t.preview)) {
          this.deadTerminals.add(t.handle);
          this.markWatchUnsupported();
          return null;
        }
        if (isBridgeTitle(t.title) || /@@OC /.test(t.preview)) {
          this.lastHelperError = null;
          return t.handle;
        }
      }
    } else {
      this.lastHelperError = serverWide.error;
    }
    if (this.watchUnsupported) {
      return null;
    }
    for (const selector of this.workspaceSelectors()) {
      if (!this.autoBridge) {
        this.lastHelperError = null;
        return null;
      }
      if (Date.now() - this.lastCreateAt < 30_000) {
        return null;
      }
      this.lastCreateAt = Date.now();
      const created = await this.helper.createTerminal({
        selector,
        title: this.terminalTitle,
        command: this.manualCommand,
        environment,
      });
      if (created.ok) {
        this.lastHelperError = null;
        return created.data.handle;
      }
      this.lastHelperError = created.error;
    }
    return null;
  }

  async readTerminal(terminalId) {
    if (this.transport === "host") {
      try {
        const res = await this.orca.host.call("terminal.read", { terminalId, maxLines: 2000 });
        if (res && Array.isArray(res.lines)) {
          return res.lines;
        }
      } catch (err) {
        // The host may not know a handle the CLI issued; fall through to the CLI transport.
        if (!this.helper?.available) throw err;
      }
      if (!this.helper?.available) {
        throw new Error("terminal.read returned no lines");
      }
      this.transport = "cli";
    }
    const res = await this.helper.readTerminal(terminalId, {
      cursor: this.cliCursor,
      limit: 2000,
      environment: this.environment,
    });
    if (!res.ok) {
      throw new Error(`orca terminal read: ${res.error}`);
    }
    if (res.data.nextCursor !== null && res.data.nextCursor !== undefined) {
      this.cliCursor = res.data.nextCursor;
    }
    if (res.data.status && res.data.status !== "running") {
      throw new Error(`bridge terminal is ${res.data.status}`);
    }
    return res.data.lines;
  }

  // Reads the first lines of every terminal in the focused workspace and adopts the one that prints
  // bridge frames, so the user may run `watch` in any terminal they like.
  async findRunningBridgeTerminal() {
    for (const t of this.workspace.terminals || []) {
      if (!t?.id || this.deadTerminals.has(t.id)) continue;
      try {
        const res = await this.orca.host.call("terminal.read", { terminalId: t.id, maxLines: 400 });
        if (Array.isArray(res?.lines) && res.lines.some((l) => String(l).includes("@@OC "))) {
          return t.id;
        }
      } catch {
        // Not readable; skip.
      }
    }
    return null;
  }

  // Reads are round trips too: 2 s while the panel is open or an answer is due, 10 s otherwise.
  start() {
    this.lastPollAt = 0;
    this.timers.push(
      setInterval(() => {
        const busy = this.inFlight.size > 0 || this.pending.size > 0 || this.isPanelActive();
        const interval = busy ? 2000 : 10_000;
        if (Date.now() - this.lastPollAt >= interval) {
          this.lastPollAt = Date.now();
          void this.poll();
        }
      }, 500),
    );
    void this.poll();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Bridge stopped."));
    }
    this.pending.clear();
    for (const flight of this.inFlight.values()) {
      for (const op of flight.ops) {
        clearTimeout(op.timer);
        if (!op.settled) op.reject(new Error("Bridge stopped."));
      }
    }
    this.inFlight.clear();
    for (const op of this.queue.splice(0)) op.reject(new Error("Bridge stopped."));
  }

  async rememberTerminal(id) {
    this.terminalId = id;
    this.cliCursor = undefined;
    this.liveSent = null;
    this.selectSent = null;
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
    if (this.ensuring) {
      return this.ensuring;
    }
    this.ensuring = this.ensureTerminalUncached().finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  async ensureTerminalUncached() {
    try {
      const stored = await this.orca.storage?.get?.(this.storageKey);
      if (typeof stored === "string" && stored && !this.deadTerminals.has(stored)) {
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
    const existing = (this.workspace.terminals || []).find(
      (t) => isBridgeTitle(t.title) && !this.deadTerminals.has(t.id),
    );
    const found = existing?.id || (await this.findRunningBridgeTerminal());
    if (found) {
      await this.rememberTerminal(found);
      this.sendRaw("snap");
      return found;
    }
    if (!this.canCreateTerminal) {
      const viaHelper = await this.ensureTerminalViaHelper();
      if (viaHelper) {
        await this.rememberTerminal(viaHelper);
        this.sendRaw("snap");
        return viaHelper;
      }
      this.lastError = !this.autoBridge
        ? `Automatic bridging is off. Open a terminal in a workspace on this server and run: ${this.manualCommand}`
        : this.lastHelperError
          ? `${this.lastHelperError}. Open a terminal in this workspace and run: ${this.manualCommand}`
          : `Open a terminal in this workspace and run: ${this.manualCommand}`;
      return null;
    }
    if (!this.autoBridge) {
      this.lastError = `Automatic bridging is off. Open a terminal in this workspace and run: ${this.manualCommand}`;
      return null;
    }
    if (Date.now() - this.lastCreateAt < 30_000) {
      return null;
    }
    this.lastCreateAt = Date.now();
    const res = await this.orca.host.call("terminal.create", {
      workspaceId: this.workspace.workspaceId,
      title: this.terminalTitle,
      command: this.manualCommand,
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
      if (await hostHas(this.orca, name)) {
        this.sendMethod = name;
        return name;
      }
    }
    this.sendMethod = "terminal.send";
    return this.sendMethod;
  }

  // Sends are serialised: two concurrent writes to one pty interleave their text and Enter keys. The
  // ";;" terminator lets `watch` recover when another client's line still merges with ours.
  sendRaw(command) {
    if (!this.terminalId) {
      return;
    }
    const text = `${command} ;;`;
    const terminalId = this.terminalId;
    this.sendChain = (this.sendChain || Promise.resolve()).then(async () => {
      if (process.env.ORCA_COLAB_BRIDGE_DEBUG) {
        this.orca.log(`bridge send via ${this.transport} to ${terminalId}: ${JSON.stringify(text)}`);
      }
      if (this.transport === "cli") {
        const res = await this.helper.sendTerminal(terminalId, text, { environment: this.environment });
        if (!res.ok) this.lastError = `orca terminal send: ${res.error}`;
        return;
      }
      const method = await this.resolveSendMethod();
      await this.orca.host.call(method, { terminalId, text, enter: true }).catch((err) => {
        this.lastError = `${method}: ${err?.message || err}`;
      });
    });
  }

  // Single-flight: concurrent reads would each fetch the same window and delay the one that matters.
  poll() {
    if (this.polling) {
      return this.polling;
    }
    this.polling = this.pollNow().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  async pollNow() {
    try {
      const terminalId = await this.ensureTerminal();
      if (!terminalId) {
        return;
      }
      const lines = await this.readTerminal(terminalId);
      if (process.env.ORCA_COLAB_BRIDGE_DEBUG) {
        const kinds = [];
        const probe = new FrameAssembler();
        for (const f of probe.ingest(lines.join("\n"))) kinds.push(`${f.kind}${f.kind === "res" ? ":" + f.payload.reqId : ""}`);
        this.orca.log(`bridge read ${lines.length} lines via ${this.transport} cursor=${this.cliCursor ?? "-"} pending=${this.pending.size} frames=[${kinds.join(",")}]`);
      }
      if (!this.lastFrameAt && lines.some((l) => WATCH_UNSUPPORTED_RE.test(String(l)))) {
        this.deadTerminals.add(terminalId);
        this.markWatchUnsupported();
        return;
      }
      for (const frame of this.assembler.ingest(lines.join("\n"))) {
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
      this.remoteProtocol = Number(payload.origin?.protocol) || 1;
      if (
        this.remoteProtocol < 2 &&
        this.autoBridge &&
        this.terminalId &&
        (this.canCreateTerminal || this.helper?.available)
      ) {
        // An older watch would silently ignore batches; start a current one and let the user close this.
        this.deadTerminals.add(this.terminalId);
        this.lastError = "Replaced an outdated bridge terminal; you can close the older Colab Bridge terminal.";
        this.terminalId = null;
        this.lastFrameAt = 0;
        this.lastCreateAt = 0;
        return;
      }
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
      if (this.settleBatch(payload)) {
        return;
      }
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

  inFlightOps() {
    const out = [];
    for (const flight of this.inFlight.values()) {
      for (const op of flight.ops) if (!op.settled) out.push(op);
    }
    return out;
  }

  optimisticOps() {
    return [...this.inFlightOps(), ...this.queue].filter((op) => op.optimistic);
  }

  decorate(snapInput) {
    const snap = applyOptimisticOps(snapInput, this.optimisticOps());
    return {
      ...snap,
      origin: {
        ...(snap.origin || { kind: "remote" }),
        hostId: this.workspace.hostId,
        workspaceName: this.workspace.workspaceName,
        environment: this.environmentName,
      },
      bridge: this.describe(),
    };
  }

  selectTask(taskId) {
    const next = taskId || "";
    if (this.selectSent === next) {
      return;
    }
    this.selectSent = next;
    this.controlPending.select = next;
    this.scheduleFlush();
  }

  setLive(on) {
    const next = Boolean(on);
    if (this.liveSent === next) {
      return;
    }
    this.liveSent = next;
    this.controlPending.live = next;
    this.scheduleFlush();
  }

  // Never blocks: the panel polls every 2 s and a slow answer would time out and freeze the old view.
  async snapshot() {
    if (this.latestSnap) {
      return this.decorate(this.latestSnap);
    }
    void this.poll();
    return this.placeholder();
  }

  placeholder() {
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
    const op = {
      id: `o${this.reqCounter}`,
      action,
      input: input ?? {},
      hooks,
      optimistic: OPTIMISTIC_ACTIONS.has(action),
      timeoutMs: hooks.timeoutMs || ACTION_TIMEOUTS_MS[action] || 45_000,
    };
    const promise = new Promise((resolve, reject) => {
      op.resolve = resolve;
      op.reject = reject;
    });
    this.queue = coalesceOps(this.queue, op);
    this.scheduleFlush();
    if (op.optimistic) {
      // The panel sees the change now; a failure comes back as a colab.actionFailed event.
      promise.catch(() => {});
      return { optimistic: true };
    }
    return promise;
  }

  // Sends run at most every FLUSH_INTERVAL_MS and never overlap: an idle bridge flushes at once, a
  // busy one folds everything that arrives meanwhile into the next batch.
  scheduleFlush() {
    if (this.flushTimer) {
      return;
    }
    const wait = Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - this.lastFlushAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, wait);
  }

  async flush() {
    if (!this.terminalId) {
      return;
    }
    const hasControl = Object.keys(this.controlPending).length > 0;
    if (this.queue.length === 0 && !hasControl) {
      return;
    }
    const ops = this.queue.splice(0);
    const control = this.controlPending;
    this.controlPending = {};
    if ((this.remoteProtocol || 1) < 2) {
      this.flushLegacy(ops, control);
      return;
    }
    this.reqCounter += 1;
    const reqId = `b${Date.now().toString(36)}${this.reqCounter}`;
    const payload = { ops: ops.map(({ id, action, input }) => ({ id, action, input })), ...control };
    // Each op keeps its own deadline; the batch is forgotten once every op has settled.
    for (const op of ops) {
      op.timer = setTimeout(() => {
        if (op.settled) return;
        op.settled = true;
        op.reject(new Error(`Timed out waiting for the remote ${op.action} to finish.`));
        if (op.optimistic) this.onEvent("actionFailed", { action: op.action, error: "timed out" }, this);
        this.forgetSettledBatch(reqId);
      }, op.timeoutMs);
    }
    this.inFlight.set(reqId, { reqId, ops });
    this.lastFlushAt = Date.now();
    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    this.sendRaw(`batch ${reqId} ${b64}`);
    void this.readUntilSettled();
  }

  // A `watch` older than protocol 2 gets one line per op; answers arrive through the pending map.
  flushLegacy(ops, control) {
    if (typeof control.select === "string") this.sendRaw(`select ${control.select}`.trim());
    if (typeof control.live === "boolean") this.sendRaw(`live ${control.live ? 1 : 0}`);
    for (const op of ops) {
      this.reqCounter += 1;
      const reqId = `r${Date.now().toString(36)}${this.reqCounter}`;
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        op.reject(new Error(`Timed out waiting for the remote ${op.action} to finish.`));
        if (op.optimistic) this.onEvent("actionFailed", { action: op.action, error: "timed out" }, this);
      }, op.timeoutMs);
      this.pending.set(reqId, {
        resolve: op.resolve,
        reject: (err) => {
          op.reject(err);
          if (op.optimistic) this.onEvent("actionFailed", { action: op.action, error: err?.message || String(err) }, this);
        },
        timer,
        hooks: op.hooks,
      });
      const b64 = Buffer.from(JSON.stringify(op.input ?? {}), "utf8").toString("base64");
      this.sendRaw(`call ${reqId} ${op.action} ${b64}`);
    }
    this.lastFlushAt = Date.now();
    void this.readUntilSettled();
  }

  forgetSettledBatch(reqId) {
    const flight = this.inFlight.get(reqId);
    if (flight && flight.ops.every((op) => op.settled)) {
      this.inFlight.delete(reqId);
    }
  }

  // Partial frames settle single ops as they finish; the final frame settles whatever is left.
  settleBatch(payload) {
    const flight = this.inFlight.get(payload.reqId);
    if (!flight) {
      return false;
    }
    const results = new Map((payload.results || []).map((r) => [r.id, r]));
    for (const op of flight.ops) {
      if (op.settled) continue;
      const r = results.get(op.id);
      if (!r) {
        if (payload.partial) continue;
        op.settled = true;
        clearTimeout(op.timer);
        op.reject(new Error(payload.error || `no result for ${op.action}`));
        continue;
      }
      op.settled = true;
      clearTimeout(op.timer);
      if (r.ok) {
        op.resolve(r.result ?? {});
      } else {
        op.reject(new Error(r.error || "remote action failed"));
        if (op.optimistic) this.onEvent("actionFailed", { action: op.action, error: r.error }, this);
      }
    }
    this.forgetSettledBatch(payload.reqId);
    if (this.queue.length > 0 || Object.keys(this.controlPending).length > 0) {
      this.scheduleFlush();
    }
    return true;
  }

  // While an answer is outstanding, read every 400 ms instead of waiting for the regular tick.
  async readUntilSettled() {
    if (this.fastReading) return;
    this.fastReading = true;
    try {
      const deadline = Date.now() + 60_000;
      let wait = 500;
      while ((this.inFlight.size > 0 || this.pending.size > 0) && Date.now() < deadline) {
        await this.sendChain?.catch?.(() => {});
        await new Promise((r) => setTimeout(r, wait));
        await this.poll().catch(() => {});
        wait = Math.min(1500, Math.round(wait * 1.5));
      }
    } finally {
      this.fastReading = false;
    }
  }
}

export default async function activate(orca, { homeDir = os.homedir() } = {}) {
  const paths = ensureColabHome(homeDir);
  const skillSync = syncBundledSkillToAgentDirs(homeDir);
  const budgetNotifiedKeys = {};
  const remoteBridges = new Map();
  const bridgesByEnvironment = new Map();
  const worktreeRowsCache = new Map();
  // ORCA_COLAB_DISABLE_ORCA_CLI=1 keeps tests from touching the real Orca on this machine.
  const remoteHelper = createOrcaRemoteHelper(
    process.env.ORCA_COLAB_DISABLE_ORCA_CLI ? { orcaBin: null } : { env: process.env },
  );
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

  let lastPanelRequestAt = 0;
  const isPanelActive = () => Date.now() - lastPanelRequestAt < 10_000;

  const onRemoteEvent = (name, payload, bridge) => {
    if (bridge !== activeBridge) {
      return;
    }
    if (name === "actionFailed") {
      orca.panels.post("colab.actionFailed", payload);
      void bridge.snapshot().then((snap) => orca.panels.post("colab.stateChanged", snap));
    } else if (name === "oauthUrl") {
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
  // A focused terminal that the local Orca lists pins the workspace to that terminal's worktree; focused
  // terminals it does not know mean the workspace is on a server; no terminals leave the question open.
  let localTerminalCache = { at: 0, byHandle: new Map() };
  const locateTerminals = async (terminals) => {
    const ids = (terminals || []).map((t) => t?.id).filter(Boolean);
    if (ids.length === 0 || !remoteHelper.available) {
      return null;
    }
    if (Date.now() - localTerminalCache.at > 30_000) {
      const listed = await remoteHelper.listTerminals(undefined);
      if (!listed.ok) return null;
      localTerminalCache = { at: Date.now(), byHandle: new Map(listed.data.map((t) => [t.handle, t])) };
    }
    const owned = ids.map((id) => localTerminalCache.byHandle.get(id)).find(Boolean);
    return owned ? { path: owned.worktreePath || null } : false;
  };
  const stickyRemote = new Set();

  const resolveBridge = async ({ force = false } = {}) => {
    if (!force && Date.now() - lastResolveAt < 1000) {
      return activeBridge;
    }
    lastResolveAt = Date.now();
    const info = await resolveWorkspaceInfo(orca, { locateTerminals, stickyRemote });
    if (info.hostId) {
      stickyRemote.add(`${info.workspaceName}|${info.branch || ""}`);
    }
    const key = `${info.workspaceId}|${info.hostId}|${info.workspaceName}`;
    if (key !== lastResolvedKey) {
      lastResolvedKey = key;
      orca.log(`focused workspace: ${info.workspaceName || "?"} id=${info.workspaceId || "?"} hostId=${info.hostId || "local"} path=${info.workspacePath || "?"}`);
    }
    resolvedWorkspace = info;
    if (!info.hostId) {
      if (activeBridge !== localBridge) {
        activeBridge = localBridge;
        orca.panels.post("colab.stateChanged", await localBridge.snapshot());
      }
      return localBridge;
    }
    const bridgeKey = info.workspaceId || `name:${info.workspaceName}|${info.branch || ""}`;
    let bridge = remoteBridges.get(bridgeKey);
    if (!bridge && !info.workspaceId) {
      // Another project on an already-connected server: reuse its bridge when its worktree list has
      // this workspace, so no second terminal is opened.
      for (const [env, shared] of bridgesByEnvironment) {
        const cached = worktreeRowsCache.get(env || "local");
        if (cached?.result?.ok && pickWorktreeRow(cached.result.data, info)) {
          bridge = shared;
          remoteBridges.set(bridgeKey, shared);
          break;
        }
      }
    }
    if (!bridge) {
      const remoteCli = await resolveCliCommand(orca, { remote: true });
      const autoStopIdleMinutes = Number(
        await readSetting(orca, "autoStopIdleMinutes", DEFAULT_AUTO_STOP_IDLE_MINUTES),
      );
      const autoBridge = await readSetting(orca, "autoBridge", true);
      bridge = new TerminalBridge({
        orca,
        workspace: info,
        remoteCli,
        autoStopIdleMinutes,
        onSnapshot: (snap, meta) => postFromBridge(bridge)(snap, meta),
        onEvent: onRemoteEvent,
        helper: remoteHelper,
        worktreeRowsCache,
        onEnvironmentResolved: (env, resolved) => {
          const shared = bridgesByEnvironment.get(env);
          if (!shared) {
            bridgesByEnvironment.set(env, resolved);
            return;
          }
          if (shared === resolved) return;
          // A second workspace on the same server resolved on its own: fold it into the shared bridge.
          resolved.stop();
          for (const [key, b] of remoteBridges) {
            if (b === resolved) remoteBridges.set(key, shared);
          }
          if (activeBridge === resolved) {
            activeBridge = shared;
            void shared.snapshot().then((snap) => orca.panels.post("colab.stateChanged", snap));
          }
        },
      });
      bridge.autoBridge = autoBridge !== false;
      bridge.isPanelActive = isPanelActive;
      remoteBridges.set(bridgeKey, bridge);
      bridge.start();
    } else {
      if (!bridge.terminalId) {
        bridge.workspace = info;
      } else {
        bridge.workspace = { ...bridge.workspace, terminals: info.terminals, workspaceName: info.workspaceName, branch: info.branch };
      }
      bridge.autoBridge = (await readSetting(orca, "autoBridge", true)) !== false;
      const remoteCli = await resolveCliCommand(orca, { remote: true });
      if (remoteCli !== bridge.remoteCli) {
        bridge.remoteCli = remoteCli;
        bridge.watchUnsupported = false;
        bridge.lastHelperError = null;
        bridge.terminalId = null;
      }
    }
    if (activeBridge !== bridge) {
      activeBridge = bridge;
      orca.panels.post("colab.stateChanged", await bridge.snapshot());
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
      throw new Error(
        info.hostId
          ? `Orca does not let plugins open terminals in a workspace on a remote server. Open one yourself and run: ${command}`
          : "No active Orca workspace found to open a terminal.",
      );
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
      bridge: activeBridge?.describe?.() || null,
      orcaCli: remoteHelper.available
        ? {
            bin: remoteHelper.orcaBin,
            activeWorktree: await remoteHelper.activeWorktree(),
            environments: await remoteHelper.listEnvironments(),
            recentTimingsMs: remoteHelper.recentTimings(),
          }
        : { bin: null },
      hostHas: {
        terminalSend: await hostHas(orca, "terminal.send"),
        terminalSendText: await hostHas(orca, "terminal.sendText"),
        terminalRead: await hostHas(orca, "terminal.read"),
      },
    };
  });

  // The panel calls this on workspace events and on its own focus so a switch shows within a poll.
  orca.panels.handle("colab.focusChanged", async () => {
    const bridge = await resolveBridge({ force: true });
    return bridge.snapshot();
  });

  orca.panels.handle("colab.dashboard", async (input = {}) => {
    lastPanelRequestAt = Date.now();
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
    (n) => !["authLogin", "authImport", "startSession", "submitTask", "getTaskLogs", "oauthReplay"].includes(n),
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

  // Sign-in always happens here, in the user's own browser. For a remote workspace the tokens are
  // then sealed to the server's watch process and imported there; the paste-the-URL path remains only
  // for a watch too old to publish a seal key.
  orca.panels.handle("colab.authLogin", async (input = {}) => {
    const bridge = await resolveBridge({ force: true });
    const sealKey = bridge.kind === "remote" ? bridge.latestSnap?.origin?.sealKey : null;
    if (bridge.kind === "remote" && sealKey) {
      const signedIn = await runLoopbackOAuthFlow({
        account: input?.account ? String(input.account) : input?.addAccount ? "auto" : "default",
        addAccount: Boolean(input?.addAccount),
        homeDir,
        persist: false,
        timeoutMs: 300_000,
        onAuthUrl: (authUrl, redirectUri) =>
          orca.panels.post("colab.oauthUrl", { authUrl, redirectUri, manual: false, origin: "local" }),
      });
      const envelope = sealForRecipient(sealKey, signedIn.credentials);
      const result = await bridge.call(
        "authImport",
        { account: signedIn.account, addAccount: signedIn.addAccount, envelope },
        { timeoutMs: 60_000 },
      );
      return finish(bridge, { ...result, status: { ...(result.status || {}), email: signedIn.email } });
    }
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
  const bridgeInterval = setInterval(() => void resolveBridge(), 1000);
  // Focus changes arrive as workspace events on hosts that emit them; the interval covers the rest.
  for (const eventName of ["workspace.changed", "workspace.created", "workspace.removed"]) {
    try {
      const off = orca.events?.on?.(eventName, () => void resolveBridge({ force: true }));
      if (typeof off === "function") cleanupFns.push(off);
    } catch {
      // Event not supported on this host.
    }
  }
  cleanupFns.push(() => clearInterval(statusInterval));
  cleanupFns.push(() => clearInterval(bridgeInterval));
  cleanupFns.push(() => clearInterval(provisioningTicker));
  cleanupFns.push(() => localBridge.stop());
  cleanupFns.push(() => {
    for (const b of new Set(remoteBridges.values())) b.stop();
    remoteBridges.clear();
    bridgesByEnvironment.clear();
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
