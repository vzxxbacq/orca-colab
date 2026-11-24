import os from "node:os";
import { run as runCreditsCommand } from "../commands/credits.mjs";
import { run as runDownCommand } from "../commands/down.mjs";
import { stopTaskById, submitTask } from "../commands/job.mjs";
import { run as runUpCommand } from "../commands/up.mjs";
import { getConsumptionUserInfo } from "./colab-api-client.mjs";
import {
  readConfig,
  resolveAccount,
  resolveAgentPolicy,
  setDefaultAccount,
  writeConfig,
} from "./colab-home.mjs";
import {
  getValidAccessToken,
  listOAuthAccounts,
  signOutOAuthAccount,
  resolveOAuthAccountKey,
  runLoopbackOAuthFlow,
} from "./colab-oauth.mjs";
import { recordBudgetSetEvent, recordCalibrateEvent } from "./credit-ledger.mjs";
import { removeProjectGuardrails, updateProjectGuardrails } from "./project-guardrails.mjs";
import { createRuntimeChannel } from "./runtime-channel.mjs";
import { mirrorTaskLog } from "./runtime-jobs.mjs";
import { setRuntimeKeep } from "./runtime-records.mjs";
import { listSessions, readSession, writeSession } from "./session-store.mjs";
import { clearFinishedTasks, readTask, readTaskLog } from "./task-store.mjs";

const NULL_STREAM = { write() {} };

// Every panel button maps to one action here, run in the plugin worker. Each action only touches
// ~/.orca-colab on this machine and the network (Colab and the runtime's proxy), never the Orca host API.
export function createPanelActions({
  homeDir = os.homedir(),
  env = process.env,
  defaultLocalCwd = () => process.cwd(),
  fetchImpl = fetch,
} = {}) {
  // What the panel starts is attributed to it in the runtime's records.
  const panelEnv = { ...env, ORCA_COLAB_AGENT: env.ORCA_COLAB_AGENT || "Orca panel" };

  const actions = {
    async authLogin(input = {}, { onAuthUrl } = {}) {
      const config = readConfig(homeDir);
      const addAccount = Boolean(input?.addAccount);
      const requested = input?.account
        ? String(input.account).trim()
        : addAccount
          ? "auto"
          : resolveAccount(config).label;
      const noBrowser = Boolean(input?.noBrowser);
      const status = await runLoopbackOAuthFlow({
        account: requested,
        addAccount,
        homeDir,
        timeoutMs: Number(input?.timeoutMs) || 300_000,
        ...(noBrowser ? { openBrowser: async () => {} } : {}),
        onAuthUrl: (authUrl, redirectUri) => {
          if (typeof onAuthUrl === "function") {
            onAuthUrl({ authUrl, redirectUri, manual: noBrowser });
          }
        },
      });
      const savedAccount = status.account || requested;
      setDefaultAccount(savedAccount, homeDir);
      try {
        const accessToken = await getValidAccessToken({ account: savedAccount, homeDir });
        if (accessToken) {
          const ccu = await getConsumptionUserInfo({ accessToken });
          if (typeof ccu.paidComputeUnitsBalance === "number") {
            recordCalibrateEvent(
              {
                account: savedAccount,
                balanceCu: ccu.paidComputeUnitsBalance,
                consumptionRateHourly: ccu.consumptionRateHourly,
                assignmentsCount: ccu.assignmentsCount,
                source: "colab-api",
              },
              homeDir,
            );
          }
        }
      } catch {
        // Balance sync right after login is best effort.
      }
      return { status };
    },

    async authSwitch(input = {}) {
      const raw = String(input?.account || "").trim();
      if (!raw) {
        throw new Error("Account is required.");
      }
      const targetKey = resolveOAuthAccountKey(raw, null, homeDir);
      setDefaultAccount(targetKey, homeDir);
      return { defaultAccount: targetKey };
    },

    async authLogout(input = {}) {
      const config = readConfig(homeDir);
      const target = input?.account
        ? resolveOAuthAccountKey(input.account, null, homeDir)
        : resolveAccount(config).label;
      await signOutOAuthAccount(target, homeDir);
      const remaining = listOAuthAccounts(homeDir);
      if (remaining.length > 0 && resolveAccount(config).label === target) {
        setDefaultAccount(remaining[0].account, homeDir);
      }
      return {};
    },

    async updatePolicy(input = {}) {
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
        { ...existing, allowedGpus: nextAllowed, maxConcurrentSessions: nextMaxConcurrent },
        homeDir,
      );
      return { policy: resolveAgentPolicy(readConfig(homeDir)) };
    },

    // The project's .orca/colab.json on this machine; `projectDir` is set by the worker from the focused
    // workspace, never by the panel. A field set to null goes back to the machine's value.
    async updateProjectGuardrails(input = {}) {
      if (!input?.projectDir) {
        throw new Error("No project on this computer is focused.");
      }
      const patch = {};
      if (Array.isArray(input.allowedGpus)) {
        patch.allowedGpus = input.allowedGpus.map((g) => String(g).trim().toUpperCase());
      } else if (input.allowedGpus === null) {
        patch.allowedGpus = null;
      }
      for (const key of ["maxConcurrentSessions", "monthlyBudgetCu", "autoStopIdleMinutes"]) {
        if (input[key] === null) {
          patch[key] = null;
        } else if (typeof input[key] === "number" && Number.isFinite(input[key]) && input[key] >= 0) {
          patch[key] = key === "monthlyBudgetCu" ? input[key] : Math.floor(input[key]);
        }
      }
      return updateProjectGuardrails(input.projectDir, patch);
    },

    async removeProjectGuardrails(input = {}) {
      if (!input?.projectDir) {
        throw new Error("No project on this computer is focused.");
      }
      return { removed: removeProjectGuardrails(input.projectDir) };
    },

    async startSession(input = {}, { onProgress } = {}) {
      const gpu = String(input?.gpu || "T4").toUpperCase();
      const args = ["--gpu", gpu];
      if (input?.account) args.push("--account", String(input.account));
      if (input?.keep) args.push("--keep");
      const logStream = {
        write(chunk) {
          const line = String(chunk).replace(/^\[colab\]\s*/, "").trim();
          if (line && typeof onProgress === "function") {
            onProgress(line);
          }
        },
      };
      try {
        // A runtime started from the panel belongs to the focused project when that is on this computer.
        await runUpCommand(args, {
          json: true,
          stdout: NULL_STREAM,
          stderr: logStream,
          env: panelEnv,
          homeDir,
          cwd: input?.projectDir || null,
        });
      } catch (err) {
        if (err?.payload?.step === "budget") {
          throw new Error(
            `${err.message} Raise ${err.payload.scope === "project" ? "this project's" : "the"} monthly budget under Guardrails & CU to start one.`,
          );
        }
        throw err;
      }
      return { gpu };
    },

    async stopSession(input = {}) {
      const args = input?.session ? ["--session", String(input.session)] : [];
      if (input?.cause) args.push("--cause", String(input.cause));
      if (input?.force) args.push("--force");
      let out = "";
      await runDownCommand(args, { json: true, stdout: { write: (c) => (out += c) }, stderr: NULL_STREAM, homeDir });
      const result = JSON.parse(out || "{}");
      if (result.reason === "in-use-elsewhere" || result.reason === "use-unknown") {
        return {
          ok: false,
          code: result.reason === "use-unknown" ? "USE_UNKNOWN" : "IN_USE_ELSEWHERE",
          session: result.session,
          inUseBy: result.inUseBy,
          error: result.error ?? null,
        };
      }
      return {};
    },

    async toggleKeep(input = {}) {
      const session = readSession(String(input?.session || ""), homeDir);
      if (!session) {
        throw new Error(`Session not found: ${input?.session}`);
      }
      writeSession({ ...session, keep: !session.keep }, homeDir);
      if (session.colabRuntime?.baseUrl && session.colabRuntime?.token) {
        try {
          await setRuntimeKeep(createRuntimeChannel({ sessionName: session.name, homeDir, fetchImpl }), session, !session.keep);
        } catch {
          // The next sync with the runtime's record decides which value stands.
        }
      }
      return { keep: !session.keep };
    },

    async submitTask(input = {}) {
      const rawCommand = String(input?.command || "").trim();
      if (!rawCommand) {
        throw new Error("Task command cannot be empty.");
      }
      const activeSessions = listSessions(homeDir).filter((s) => s.state !== "zombie");
      if (activeSessions.length === 0) {
        return {
          ok: false,
          code: "NO_ACTIVE_SESSION",
          message: "No active Colab GPU runtime. Let's launch a GPU session first.",
        };
      }
      const localCwd = input?.workspacePath || defaultLocalCwd();
      const { task } = await submitTask(
        {
          name: input?.name ? String(input.name).trim() : undefined,
          command: [rawCommand],
          sessionName: input?.session || undefined,
          cwd: input?.cwd ? String(input.cwd).trim() : null,
          syncPath: input?.syncWorkspace ? localCwd : null,
          wait: false,
        },
        { homeDir, localCwd, env: panelEnv },
      );
      return { ok: true, task };
    },

    async stopTask(input = {}) {
      return { task: await stopTaskById(String(input?.taskId || ""), { homeDir }) };
    },

    async clearFinishedTasks(input = {}) {
      const sessionName = input?.sessionName ? String(input.sessionName) : null;
      return { removed: clearFinishedTasks(homeDir, { sessionName }) };
    },

    async getTaskLogs(input = {}) {
      const taskId = String(input?.taskId || "");
      let task = readTask(taskId, homeDir);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      if (task.runtimeBacked && !task.logComplete) {
        task = await mirrorTaskLog({ task, homeDir, fetchImpl }).catch(() => task);
      }
      const logSnap = readTaskLog(taskId, homeDir, {
        tailLines: Number(input?.tailLines || 300),
        maxBytes: Number(input?.maxBytes) || 65536,
      });
      return { task, output: logSnap.text, totalBytes: logSnap.totalBytes, truncated: logSnap.truncated };
    },

    async calibrateCredits(input = {}) {
      const args = ["calibrate"];
      if (input?.account) args.push("--account", String(input.account));
      if (input?.browser) args.push("--browser");
      await runCreditsCommand(args, { json: true, stdout: NULL_STREAM, stderr: NULL_STREAM, env, homeDir });
      return {};
    },

    async setCredits(input = {}) {
      const balanceCu = Number(input?.balanceCu);
      if (!Number.isFinite(balanceCu) || balanceCu < 0) {
        throw new Error("Balance must be a non-negative number.");
      }
      const account = resolveAccount(readConfig(homeDir), input?.account).label;
      recordCalibrateEvent({ account, balanceCu, source: "manual" }, homeDir);
      return {};
    },

    async setBudget(input = {}) {
      const budgetCu = Number(input?.budgetCu);
      if (!Number.isFinite(budgetCu) || budgetCu < 0) {
        throw new Error("Budget must be a non-negative number.");
      }
      const account = resolveAccount(readConfig(homeDir), input?.account).label;
      recordBudgetSetEvent({ account, budgetCu }, homeDir);
      return {};
    },
  };

  return actions;
}

export const PANEL_ACTION_NAMES = Object.freeze([
  "authLogin",
  "authSwitch",
  "authLogout",
  "updatePolicy",
  "updateProjectGuardrails",
  "removeProjectGuardrails",
  "startSession",
  "stopSession",
  "toggleKeep",
  "submitTask",
  "stopTask",
  "clearFinishedTasks",
  "getTaskLogs",
  "calibrateCredits",
  "setCredits",
  "setBudget",
]);
