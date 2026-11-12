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
  readOAuthStore,
  removeOAuthCredentials,
  resolveOAuthAccountKey,
  resolveTargetAccount,
  runLoopbackOAuthFlow,
  saveOAuthCredentials,
} from "./colab-oauth.mjs";
import { recordBudgetSetEvent, recordCalibrateEvent } from "./credit-ledger.mjs";
import { listSessions, readSession, writeSession } from "./session-store.mjs";
import { clearFinishedTasks, readTask, readTaskLog } from "./task-store.mjs";

const NULL_STREAM = { write() {} };

// Every panel button maps to one action here. The worker runs them in-process for a local workspace
// and `orca-colab watch` runs the same functions on a remote Orca server, so each action only touches
// ~/.orca-colab and the network, never the Orca host API.
export function createPanelActions({
  homeDir = os.homedir(),
  env = process.env,
  defaultLocalCwd = () => process.cwd(),
} = {}) {
  let pendingOAuthRedirectUri = null;

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
          pendingOAuthRedirectUri = redirectUri;
          if (typeof onAuthUrl === "function") {
            onAuthUrl({ authUrl, redirectUri, manual: noBrowser });
          }
        },
      });
      pendingOAuthRedirectUri = null;
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

    // Stores credentials obtained by a sign-in that ran elsewhere (the desktop client), then syncs the
    // balance like a local sign-in would.
    async authImport(input = {}) {
      const credentials = input?.credentials;
      if (!credentials?.refreshToken && !credentials?.accessToken) {
        throw new Error("authImport needs credentials with a refresh or access token.");
      }
      const targetAccount = resolveTargetAccount({
        store: readOAuthStore(homeDir),
        account: input?.account || "default",
        addAccount: Boolean(input?.addAccount),
        email: credentials.email || null,
      });
      const status = saveOAuthCredentials(targetAccount, credentials, homeDir);
      setDefaultAccount(targetAccount, homeDir);
      try {
        const accessToken = await getValidAccessToken({ account: targetAccount, homeDir });
        if (accessToken) {
          const ccu = await getConsumptionUserInfo({ accessToken });
          if (typeof ccu.paidComputeUnitsBalance === "number") {
            recordCalibrateEvent(
              {
                account: targetAccount,
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
        // Balance sync is best effort.
      }
      return { status };
    },

    // The browser on the user's laptop cannot reach the loopback server on a remote host, so the user
    // pastes the redirect URL and this replays it against the server that is still waiting for it.
    async oauthReplay(input = {}) {
      const raw = String(input?.redirectUrl || "").trim();
      if (!pendingOAuthRedirectUri) {
        throw new Error("No Google sign-in is waiting for a redirect URL. Start sign-in first.");
      }
      let pasted;
      try {
        pasted = new URL(raw);
      } catch {
        throw new Error("Paste the full URL the browser was redirected to (it starts with http://127.0.0.1:).");
      }
      const expected = new URL(pendingOAuthRedirectUri);
      if (pasted.hostname !== expected.hostname || pasted.port !== expected.port) {
        throw new Error(`Redirect URL must point at ${expected.origin}; got ${pasted.origin}.`);
      }
      const res = await fetch(`${expected.origin}/${pasted.search}`);
      if (!res.ok) {
        throw new Error(`Sign-in server rejected the redirect: HTTP ${res.status}.`);
      }
      return { ok: true };
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
      removeOAuthCredentials(target, homeDir);
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
      await runUpCommand(args, { json: true, stdout: NULL_STREAM, stderr: logStream, env, homeDir });
      return { gpu };
    },

    async stopSession(input = {}) {
      const args = input?.session ? ["--session", String(input.session)] : [];
      if (input?.cause) args.push("--cause", String(input.cause));
      await runDownCommand(args, { json: true, stdout: NULL_STREAM, stderr: NULL_STREAM, homeDir });
      return {};
    },

    async toggleKeep(input = {}) {
      const session = readSession(String(input?.session || ""), homeDir);
      if (!session) {
        throw new Error(`Session not found: ${input?.session}`);
      }
      writeSession({ ...session, keep: !session.keep }, homeDir);
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
        { homeDir, localCwd, env },
      );
      return { ok: true, task };
    },

    async stopTask(input = {}) {
      return { task: stopTaskById(String(input?.taskId || ""), { homeDir }) };
    },

    async clearFinishedTasks(input = {}) {
      const sessionName = input?.sessionName ? String(input.sessionName) : null;
      return { removed: clearFinishedTasks(homeDir, { sessionName }) };
    },

    async getTaskLogs(input = {}) {
      const taskId = String(input?.taskId || "");
      const task = readTask(taskId, homeDir);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
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
  "authImport",
  "oauthReplay",
  "authSwitch",
  "authLogout",
  "updatePolicy",
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
