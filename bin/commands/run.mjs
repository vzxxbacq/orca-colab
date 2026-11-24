import { parseArgs } from "node:util";
import { resolveSessionAcrossMachines } from "../lib/account-runtimes.mjs";
import { CliError, writeJson } from "../lib/cli-output.mjs";
import {
  execCommandOverTty,
  runInteractiveTtySession,
} from "../lib/colab-api-client.mjs";
import { runTaskOnRuntime, stopRuntimeTask, taskLogFooter } from "../lib/runtime-jobs.mjs";
import { describeOrigin } from "../lib/runtime-records.mjs";
import { withSessionActivity } from "../lib/session-activity.mjs";
import { requireColabRuntime } from "../lib/session-store.mjs";
import {
  appendTaskLog,
  generateTaskId,
  readTask,
  writeTask,
} from "../lib/task-store.mjs";

export function shellQuote(value) {
  const str = String(value);
  if (/^[A-Za-z0-9_./:@=-]+$/.test(str)) {
    return str;
  }
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

export function buildRemoteShellCommand({
  cmdArgs,
  cwd = null,
  envVars = [],
  detach = null,
  attach = null,
}) {
  if (attach) {
    return `tmux attach-session -t ${shellQuote(attach)}`;
  }
  if (!Array.isArray(cmdArgs) || cmdArgs.length === 0) {
    throw new CliError("missing command to run (usage: orca-colab run [--session N] [--cwd DIR] -- <cmd...>)");
  }

  const baseCmd =
    cmdArgs.length === 1 ? cmdArgs[0] : cmdArgs.map(shellQuote).join(" ");

  const prefixes = [];
  for (const pair of envVars) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new CliError(`invalid --env value '${pair}' (expected KEY=VALUE)`);
    }
    const key = pair.slice(0, eq);
    const val = pair.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new CliError(`invalid environment variable name: ${key}`);
    }
    prefixes.push(`export ${key}=${shellQuote(val)}`);
  }

  if (cwd) {
    prefixes.push(`cd ${shellQuote(cwd)}`);
  }

  const innerScript =
    prefixes.length > 0 ? `${prefixes.join(" && ")} && ${baseCmd}` : baseCmd;

  if (detach) {
    return `tmux new-session -d -s ${shellQuote(detach)} ${shellQuote(`sh -c ${shellQuote(innerScript)}`)}`;
  }
  return innerScript;
}

export async function run(
  argv,
  {
    json,
    stdout,
    stderr,
    homeDir,
    env = process.env,
    cwd = process.cwd(),
    stdinIsTTY = Boolean(process.stdin.isTTY),
    execTty = execCommandOverTty,
    fetchImpl = fetch,
    withActivity = withSessionActivity,
    onInterrupt = (handler) => {
      process.once("SIGINT", handler);
      return () => process.removeListener("SIGINT", handler);
    },
  },
) {
  const dashDash = argv.indexOf("--");
  const flagArgs = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const tailArgs = dashDash === -1 ? [] : argv.slice(dashDash + 1);

  let parsed;
  try {
    parsed = parseArgs({
      args: flagArgs,
      options: {
        session: { type: "string" },
        cwd: { type: "string" },
        env: { type: "string", multiple: true },
        detach: { type: "string" },
        attach: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const opts = parsed.values;
  const cmdArgs =
    tailArgs.length > 0 ? tailArgs : parsed.positionals;

  const session = await resolveSessionAcrossMachines({
    sessionName: opts.session ?? null,
    homeDir,
    fetchImpl,
  });

  const effectiveCwd = opts.cwd ?? session.remoteRoot ?? null;
  const remoteScript = buildRemoteShellCommand({
    cmdArgs,
    cwd: effectiveCwd,
    envVars: opts.env ?? [],
    detach: opts.detach ?? null,
    attach: opts.attach ?? null,
  });

  requireColabRuntime(session);
  const execute = async () => {
    const joinedCmd = cmdArgs.join(" ").trim();
    const isInteractiveShell =
      stdinIsTTY &&
      !json &&
      !opts.detach &&
      (joinedCmd === "bash" || joinedCmd === "bash -l" || joinedCmd === "sh");

    if (isInteractiveShell) {
      return await runInteractiveTtySession({
        baseUrl: session.colabRuntime.baseUrl,
        proxyToken: session.colabRuntime.token,
        cwd: effectiveCwd,
      });
    }

    const taskId = generateTaskId();
    const startedAt = new Date().toISOString();
    const taskRecord = writeTask(
      {
        id: taskId,
        name: joinedCmd.slice(0, 64) || "orca-colab run",
        command: cmdArgs,
        sessionName: session.name,
        account: session.account || "default",
        cwd: effectiveCwd,
        status: "running",
        createdAt: startedAt,
        startedAt,
        localPid: process.pid,
        origin: describeOrigin({ env, cwd }),
      },
      homeDir,
    );
    const logHead = `[task ${taskId}] started at ${startedAt} on ${session.name} (${session.gpu?.name || "GPU"})\n$ ${joinedCmd}\n`;

    // `tmux attach` needs the terminal it is typed into, so it cannot run detached like everything else.
    if (opts.attach) {
      appendTaskLog(taskId, logHead, homeDir);
      const attached = await execTty({
        baseUrl: session.colabRuntime.baseUrl,
        proxyToken: session.colabRuntime.token,
        command: remoteScript,
        cwd: effectiveCwd,
        onOutput: (chunk) => {
          appendTaskLog(taskId, chunk, homeDir);
          if (!json) stdout.write(chunk);
        },
      });
      const done = writeTask(
        { ...taskRecord, status: attached.exitCode === 0 ? "succeeded" : "failed", exitCode: attached.exitCode, finishedAt: new Date().toISOString() },
        homeDir,
      );
      appendTaskLog(taskId, taskLogFooter(done), homeDir);
      if (json) {
        writeJson({ ok: attached.ok, session: session.name, exitCode: attached.exitCode, stdout: attached.stdout, stderr: "" }, stdout);
      }
      return attached.exitCode;
    }

    // The command runs detached on the runtime with its output in a file there (so every machine reads
    // the same complete log) and is followed from here; Ctrl-C stops it instead of abandoning it.
    const collected = [];
    let interrupted = false;
    let stopping = null;
    const stopListening = onInterrupt(() => {
      interrupted = true;
      const current = readTask(taskId, homeDir, { reconcile: false });
      if (current?.status === "running") {
        const stopped = writeTask({ ...current, status: "stopped", exitCode: 130, finishedAt: new Date().toISOString(), localPid: null }, homeDir);
        appendTaskLog(taskId, taskLogFooter(stopped), homeDir);
        stopping = stopRuntimeTask({ task: stopped, homeDir, fetchImpl }).catch(() => {});
      }
    });
    let followed;
    try {
      followed = await runTaskOnRuntime({
        task: taskRecord,
        session,
        script: remoteScript,
        logHead,
        homeDir,
        execTty,
        fetchImpl,
        pollMs: 500,
        onOutput: (chunk) => {
          collected.push(chunk);
          if (!json) stdout.write(chunk);
        },
      });
    } catch (err) {
      const current = readTask(taskId, homeDir, { reconcile: false }) || taskRecord;
      appendTaskLog(taskId, `\n[task ${taskId}] ${err?.followLost ? "stopped following" : "failed"}: ${err?.message || err}\n`, homeDir);
      if (err?.followLost && current.runtimeBacked) {
        writeTask({ ...current, localPid: null }, homeDir);
      } else {
        writeTask(
          { ...current, status: "failed", exitCode: 1, finishedAt: new Date().toISOString(), localPid: null, error: String(err?.message || err) },
          homeDir,
        );
      }
      throw err;
    } finally {
      stopListening?.();
      await stopping;
    }

    const record = followed.record;
    const res = {
      ok: !interrupted && record?.exitCode === 0,
      exitCode: interrupted || !record ? 130 : record.exitCode ?? 1,
      stdout: collected.join("").replace(/\r?\n$/, ""),
      stderr: "",
    };
    if (record) {
      const latest = readTask(taskId, homeDir, { reconcile: false }) || taskRecord;
      const settled = writeTask(
        {
          ...latest,
          status: record.status,
          exitCode: record.exitCode ?? 1,
          finishedAt: record.finishedAt || new Date().toISOString(),
          localPid: null,
          runtimeLogOffset: followed.logOffset,
          logComplete: true,
        },
        homeDir,
      );
      appendTaskLog(taskId, taskLogFooter(settled), homeDir);
    }

    if (json) {
      writeJson(
        {
          ok: res.ok,
          session: session.name,
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
        },
        stdout,
      );
    }
    return res.exitCode;
  };

  if (withActivity) {
    return withActivity(session.name, homeDir, execute, { env, command: cmdArgs.join(" ").slice(0, 120), fetchImpl });
  }
  return execute();
}
