import { parseArgs } from "node:util";
import { CliError, writeJson } from "../lib/cli-output.mjs";
import {
  execCommandOverTty,
  runInteractiveTtySession,
} from "../lib/colab-api-client.mjs";
import { withSessionActivity } from "../lib/session-activity.mjs";
import { requireColabRuntime, resolveSession } from "../lib/session-store.mjs";
import {
  appendTaskLog,
  generateTaskId,
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
    stdinIsTTY = Boolean(process.stdin.isTTY),
    execTty = execCommandOverTty,
    withActivity = withSessionActivity,
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

  const session = resolveSession({
    sessionName: opts.session ?? null,
    homeDir,
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
      },
      homeDir,
    );
    appendTaskLog(
      taskId,
      `[task ${taskId}] started at ${startedAt} on ${session.name} (${session.gpu?.name || "GPU"})\n$ ${joinedCmd}\n`,
      homeDir,
    );

    let res;
    try {
      res = await execTty({
        baseUrl: session.colabRuntime.baseUrl,
        proxyToken: session.colabRuntime.token,
        command: remoteScript,
        cwd: effectiveCwd,
        onOutput: (chunk) => {
          appendTaskLog(taskId, chunk, homeDir);
          if (!json) {
            stdout.write(chunk);
          }
        },
      });
    } catch (err) {
      const finishedAt = new Date().toISOString();
      appendTaskLog(
        taskId,
        `\n[task ${taskId}] failed at ${finishedAt}: ${err?.message || err}\n`,
        homeDir,
      );
      writeTask(
        {
          ...taskRecord,
          status: "failed",
          exitCode: 1,
          finishedAt,
        },
        homeDir,
      );
      throw err;
    }

    const finishedAt = new Date().toISOString();
    appendTaskLog(
      taskId,
      `\n[task ${taskId}] ${res.exitCode === 0 ? "succeeded" : "failed"} at ${finishedAt} (exit code ${res.exitCode})\n`,
      homeDir,
    );
    writeTask(
      {
        ...taskRecord,
        status: res.exitCode === 0 ? "succeeded" : "failed",
        exitCode: res.exitCode,
        finishedAt,
      },
      homeDir,
    );

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
    return withActivity(session.name, homeDir, execute);
  }
  return execute();
}
