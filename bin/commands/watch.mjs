import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import os from "node:os";
import { parseArgs } from "node:util";
import { encodeFrame } from "../lib/bridge-frames.mjs";
import { createEnvelopeKeyPair, openEnvelope } from "../lib/credential-envelope.mjs";
import { getRuntime } from "../lib/colab-api-client.mjs";
import { getColabPaths } from "../lib/colab-home.mjs";
import { getValidAccessToken } from "../lib/colab-oauth.mjs";
import { CliError, EXIT_OK } from "../lib/cli-output.mjs";
import { recordSessionEndEvent, resolveDeadSessionEndIso } from "../lib/credit-ledger.mjs";
import { DashboardSnapshotBuilder } from "../lib/dashboard-snapshot.mjs";
import {
  DEFAULT_AUTO_STOP_IDLE_MINUTES,
  evaluateSessionIdleState,
  GRACE_PERIOD_MINUTES,
} from "../lib/idle-watchdog.mjs";
import { createPanelActions } from "../lib/panel-actions.mjs";
import { deleteSession, listSessions, readSession, writeSession } from "../lib/session-store.mjs";
import { listTasks } from "../lib/task-store.mjs";

// 2 = understands `batch` and the ";;" terminator. Clients fall back to single `call` lines below it.
export const WATCH_PROTOCOL = 2;
export const WATCH_SNAPSHOT_TAIL_LINES = 120;
export const WATCH_SNAPSHOT_LOG_BYTES = 16384;
const HEARTBEAT_MS = 20_000;
const POLL_MS = 1500;
const WATCHDOG_MS = 5 * 60_000;

export const CONTROL_TERMINATOR = ";;";
const CONTROL_SEGMENT_RE = /\b(call|batch|live|select|snap|ping|quit)\b[^;]*?;;/g;

// Several clients may type into one bridge terminal at once and their lines can merge, so every
// control line ends in ";;" and a merged line is split back into its commands. Lines without the
// terminator (older clients) are parsed whole.
export function parseControlLines(line) {
  const text = String(line);
  if (!text.includes(CONTROL_TERMINATOR)) {
    const one = parseControlLine(text);
    return one ? [one] : [];
  }
  const out = [];
  CONTROL_SEGMENT_RE.lastIndex = 0;
  let match;
  while ((match = CONTROL_SEGMENT_RE.exec(text)) !== null) {
    const parsed = parseControlLine(match[0].slice(0, -CONTROL_TERMINATOR.length));
    if (parsed) out.push(parsed);
  }
  return out;
}

// Parses one control command. Arguments travel base64-encoded so that a pty's line discipline never
// sees quotes, newlines or control characters from user input.
export function parseControlLine(line) {
  const trimmed = String(line).replace(/;;\s*$/, "").trim();
  if (!trimmed) {
    return null;
  }
  const [verb, ...rest] = trimmed.split(/\s+/);
  switch (verb) {
    case "batch": {
      // batch <reqId> <b64 of { ops: [{ id, action, input }], select?, live? }>
      const [reqId, b64] = rest;
      if (!reqId || !b64) {
        return null;
      }
      try {
        const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
        return { verb, reqId, ops: Array.isArray(payload?.ops) ? payload.ops : [], control: payload || {} };
      } catch {
        return { verb, reqId, error: `malformed batch (${b64.length} chars)` };
      }
    }
    case "ping":
    case "quit":
    case "snap":
      return { verb };
    case "select":
      return { verb, taskId: rest[0] || null };
    case "live":
      return { verb, on: rest[0] === "1" };
    case "call": {
      const [reqId, action, b64] = rest;
      if (!reqId || !action) {
        return null;
      }
      let input = {};
      if (b64) {
        try {
          input = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
        } catch {
          return { verb, reqId, action, error: `malformed input (${b64.length} chars: ${b64.slice(0, 24)}…)` };
        }
      }
      return { verb, reqId, action, input };
    }
    default:
      return null;
  }
}

export function snapshotFingerprint(snap) {
  const tasks = (snap.tasks || [])
    .map((t) => `${t.id}:${t.status}:${t.exitCode}:${t.finishedAt || ""}`)
    .join("|");
  const sessions = (snap.sessions || [])
    .map((s) => `${s.name}:${s.state}:${s.keep ? 1 : 0}:${s.liveMetrics?.gpuUtilizationPercent ?? ""}`)
    .join("|");
  const out = snap.activeTaskOutput
    ? `${snap.activeTaskOutput.taskId}:${snap.activeTaskOutput.totalBytes}:${snap.activeTaskOutput.status}`
    : "";
  const auth = Object.values(snap.authByAccount || {})
    .map((a) => `${a.account}:${a.authenticated ? 1 : 0}`)
    .join("|");
  const credits = `${snap.credits?.estimatedBalanceCu ?? ""}:${snap.credits?.budgetCu ?? ""}`;
  const prov = `${snap.provisioning?.active ? 1 : 0}:${snap.provisioning?.message || ""}:${snap.provisioning?.error || ""}`;
  return [tasks, sessions, out, auth, credits, prov, snap.policy?.allowedGpus?.join(",") || ""].join("#");
}

export async function run(
  argv,
  {
    stdout = process.stdout,
    stdin = process.stdin,
    env = process.env,
    homeDir = os.homedir(),
    cwd = process.cwd(),
    signal,
    hostLabel = os.hostname(),
  } = {},
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "auto-stop-idle-minutes": { type: "string" },
        "no-watchdog": { type: "boolean", default: false },
      },
      strict: true,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  const autoStopIdleMinutes = Number.isFinite(Number(parsed.values["auto-stop-idle-minutes"]))
    ? Number(parsed.values["auto-stop-idle-minutes"])
    : DEFAULT_AUTO_STOP_IDLE_MINUTES;

  if (stdin.isTTY) {
    try {
      spawnSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
    } catch {
      // Echo stays on; frames are still parsed from the screen.
    }
  }

  stdout.write(
    `[colab] Orca Colab bridge for ${hostLabel} (${getColabPaths(homeDir).baseDir}). The Orca Colab panel on your desktop reads this terminal; leave it open.\n`,
  );

  // Fresh per process: clients seal credentials to this key so the terminal only ever shows ciphertext.
  const sealKeys = createEnvelopeKeyPair();
  const builder = new DashboardSnapshotBuilder({
    homeDir,
    env,
    origin: {
      kind: "remote",
      host: hostLabel,
      platform: process.platform,
      protocol: WATCH_PROTOCOL,
      sealKey: sealKeys.publicKeyB64,
    },
  });
  const actions = createPanelActions({ homeDir, env, defaultLocalCwd: () => cwd });

  let seq = 0;
  const emit = (kind, payload) => {
    seq += 1;
    stdout.write(`${encodeFrame(kind, seq, payload).join("\n")}\n`);
  };

  let selectedTaskId = null;
  let includeLiveMetrics = false;
  let provisioningState = { active: false, message: null, error: null };
  let lastFingerprint = "";
  let lastEmitAt = 0;
  let stopped = false;

  const emitSnapshot = async ({ force = false } = {}) => {
    const snap = await builder.build({
      includeLiveMetrics,
      selectedTaskId,
      provisioningState,
      tailLines: WATCH_SNAPSHOT_TAIL_LINES,
      logMaxBytes: WATCH_SNAPSHOT_LOG_BYTES,
    });
    const fp = snapshotFingerprint(snap);
    if (force || fp !== lastFingerprint || Date.now() - lastEmitAt > HEARTBEAT_MS) {
      lastFingerprint = fp;
      lastEmitAt = Date.now();
      emit("snap", snap);
    }
  };

  const hooks = {
    onAuthUrl: (payload) => emit("evt", { name: "oauthUrl", payload }),
    onProgress: (message) => {
      provisioningState = { active: true, message, error: null };
      emit("evt", { name: "provisioningProgress", payload: provisioningState });
    },
  };

  // Runs one panel action and returns { ok, result | error } without emitting anything.
  const runAction = async (action, inputRaw) => {
    const fn = actions[action];
    if (typeof fn !== "function") {
      return { ok: false, error: `unknown action: ${action}` };
    }
    let input = inputRaw;
    if (action === "authImport" && input?.envelope) {
      try {
        input = { ...input, envelope: undefined, credentials: openEnvelope(sealKeys.privateKey, input.envelope) };
      } catch (err) {
        return { ok: false, error: `could not open credential envelope: ${err?.message || err}` };
      }
    }
    if (action === "startSession") {
      provisioningState = {
        active: true,
        message: `Assigning Colab ${String(input?.gpu || "T4").toUpperCase()} runtime via Google Colab Direct API...`,
        error: null,
      };
      await emitSnapshot({ force: true });
    }
    try {
      const result = await fn(input, hooks);
      if (action === "startSession") {
        provisioningState = { active: false, message: null, error: null };
      }
      if (["authLogin", "authImport", "authSwitch", "authLogout"].includes(action)) {
        builder.invalidateDoctor();
      }
      if (action === "submitTask" && result?.task?.id) {
        selectedTaskId = result.task.id;
      }
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (action === "startSession") {
        provisioningState = { active: false, message: null, error: message };
      }
      return { ok: false, error: message };
    }
  };

  const handleCall = async ({ reqId, action, input, error }) => {
    if (error) {
      emit("res", { reqId, ok: false, error });
      return;
    }
    const outcome = await runAction(action, input);
    emit("res", { reqId, ...outcome });
    await emitSnapshot({ force: true });
  };

  // One round trip for many operations: every result comes back in one frame, then one snapshot.
  const handleBatch = async ({ reqId, ops, control, error }) => {
    if (error) {
      emit("res", { reqId, ok: false, error });
      return;
    }
    if (typeof control?.select === "string") {
      selectedTaskId = control.select || null;
    }
    if (typeof control?.live === "boolean") {
      includeLiveMetrics = control.live;
    }
    // Ops run concurrently and each answers as soon as it finishes, so a slow runtime assignment never
    // holds up a budget change that shares its batch; the final frame repeats everything.
    const results = await Promise.all(
      ops.map(async (op) => {
        const outcome = await runAction(op.action, op.input ?? {});
        const result = { id: op.id, action: op.action, ...outcome };
        emit("res", { reqId, partial: true, results: [result] });
        void emitSnapshot({ force: true });
        return result;
      }),
    );
    emit("res", { reqId, ok: results.every((r) => r.ok), results });
    await emitSnapshot({ force: true });
  };

  const watchdogTick = async () => {
    if (parsed.values["no-watchdog"]) {
      return;
    }
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
          if (err?.status === 404) {
            deleteSession(s.name, homeDir);
            recordSessionEndEvent(s, {
              cause: "colab-died",
              endedAt: resolveDeadSessionEndIso(s, Date.now()),
              homeDir,
            });
            await emitSnapshot({ force: true });
            continue;
          }
        }
      }
      const metrics = builder.liveMetricsBySession.get(s.name);
      if (metrics && typeof metrics.gpuUtilizationPercent === "number") {
        builder.recordGpuSample(s.name, metrics.gpuUtilizationPercent);
      }
      const runningCount = tasks.filter((t) => t.sessionName === s.name && t.status === "running").length;
      const decision = evaluateSessionIdleState({
        session: s,
        gpuSamples: builder.gpuUtilSamplesBySession.get(s.name) || [],
        runningTasksCount: runningCount,
        autoStopIdleMinutes,
        nowMs: Date.now(),
      });
      if (decision.isIdle && !graceTimers.has(s.name)) {
        emit("evt", {
          name: "notify",
          payload: {
            message: `Colab session ${s.name} has been idle for ${Math.round(decision.idleMinutes)} min (<5% GPU). Stopping in ${GRACE_PERIOD_MINUTES} min unless used or marked Keep.`,
            tone: "warning",
          },
        });
        const timer = setTimeout(async () => {
          graceTimers.delete(s.name);
          const latest = readSession(s.name, homeDir);
          const latestRunning = listTasks(homeDir).filter(
            (t) => t.sessionName === s.name && t.status === "running",
          ).length;
          const recheck = evaluateSessionIdleState({
            session: latest,
            gpuSamples: builder.gpuUtilSamplesBySession.get(s.name) || [],
            runningTasksCount: latestRunning,
            autoStopIdleMinutes,
            nowMs: Date.now(),
          });
          if (recheck.isIdle) {
            await actions.stopSession({ session: s.name, cause: "idle-watchdog" }).catch(() => {});
            emit("evt", {
              name: "notify",
              payload: { message: `Auto-stopped idle Colab session ${s.name} to save compute units.`, tone: "info" },
            });
            await emitSnapshot({ force: true });
          }
        }, GRACE_PERIOD_MINUTES * 60_000);
        graceTimers.set(s.name, timer);
      } else if (!decision.isIdle && graceTimers.has(s.name)) {
        clearTimeout(graceTimers.get(s.name));
        graceTimers.delete(s.name);
      }
    }
  };
  const graceTimers = new Map();

  const rl = createInterface({ input: stdin, terminal: false });
  const finished = new Promise((resolve) => {
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(watchdogTimer);
      for (const t of graceTimers.values()) clearTimeout(t);
      rl.close();
      resolve();
    };
    const handleControl = (ctl) => {
      if (ctl.verb === "quit") {
        stop();
        return;
      }
      if (ctl.verb === "ping") {
        emit("evt", { name: "pong", payload: { at: Date.now(), protocol: WATCH_PROTOCOL } });
        return;
      }
      if (ctl.verb === "select") {
        selectedTaskId = ctl.taskId;
        void emitSnapshot({ force: true });
        return;
      }
      if (ctl.verb === "live") {
        includeLiveMetrics = ctl.on;
        return;
      }
      if (ctl.verb === "snap") {
        void emitSnapshot({ force: true });
        return;
      }
      if (ctl.verb === "batch") {
        void handleBatch(ctl);
        return;
      }
      void handleCall(ctl);
    };
    rl.on("line", (line) => {
      for (const ctl of parseControlLines(line)) handleControl(ctl);
    });
    rl.on("close", stop);
    stdin.on?.("end", stop);
    signal?.addEventListener?.("abort", stop, { once: true });
  });

  const pollTimer = setInterval(() => {
    emitSnapshot().catch(() => {});
  }, POLL_MS);
  const watchdogTimer = setInterval(() => {
    watchdogTick().catch(() => {});
  }, WATCHDOG_MS);

  await emitSnapshot({ force: true });
  await finished;
  return EXIT_OK;
}
