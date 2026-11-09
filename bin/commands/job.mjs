import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_ERROR,
  EXIT_OK,
  log,
  writeJson,
} from "../lib/cli-output.mjs";
import { execCommandOverTty } from "../lib/colab-api-client.mjs";
import { withSessionActivity } from "../lib/session-activity.mjs";
import { readSession, resolveSession } from "../lib/session-store.mjs";
import { buildSshExecArgs, execSshCapture } from "../lib/ssh-exec.mjs";
import {
  appendTaskLog,
  generateTaskId,
  listTasks,
  readTask,
  readTaskLog,
  writeTask,
} from "../lib/task-store.mjs";
import { buildRemoteShellCommand } from "./run.mjs";
import { run as runSyncCommand } from "./sync.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY_PATH = path.resolve(__dirname, "..", "orca-colab.mjs");

export async function executeTaskInline(
  taskId,
  {
    homeDir = os.homedir(),
    cwd = process.cwd(),
    env = process.env,
    spawnChild = spawn,
    streamToStdout = false,
    stdout = process.stdout,
    stderr = process.stderr,
    withActivity = withSessionActivity,
  } = {},
) {
  const task = readTask(taskId, homeDir, { reconcile: false });
  if (!task) {
    throw new CliError(`task not found: ${taskId}`);
  }
  const session = readSession(task.sessionName, homeDir);
  if (!session) {
    appendTaskLog(
      task.id,
      `[colab] error: session '${task.sessionName}' not found.\n`,
      homeDir,
    );
    writeTask(
      {
        ...task,
        status: "failed",
        exitCode: 1,
        finishedAt: new Date().toISOString(),
      },
      homeDir,
    );
    return EXIT_ERROR;
  }

  const runCore = async () => {
    let effectiveCwd = task.cwd || session.remoteRoot || null;

    if (task.syncPath) {
      appendTaskLog(
        task.id,
        `[task ${task.id}] syncing '${task.syncPath}' to ${session.name}...\n`,
        homeDir,
      );
      const syncChunks = [];
      const fakeStream = {
        write(chunk) {
          const text = String(chunk);
          syncChunks.push(text);
          appendTaskLog(task.id, text, homeDir);
        },
      };
      try {
        await runSyncCommand(["--session", session.name, task.syncPath], {
          json: false,
          stdout: fakeStream,
          stderr: fakeStream,
          cwd,
          env,
          homeDir,
        });
        const refreshed = readSession(session.name, homeDir);
        if (!effectiveCwd && refreshed?.remoteRoot) {
          effectiveCwd = refreshed.remoteRoot;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendTaskLog(task.id, `[task ${task.id}] sync failed: ${msg}\n`, homeDir);
        writeTask(
          {
            ...task,
            status: "failed",
            exitCode: 1,
            finishedAt: new Date().toISOString(),
          },
          homeDir,
        );
        return EXIT_ERROR;
      }
    }

    const envPairs = Object.entries({
      ...task.env,
      ORCA_TASK_ID: task.id,
      PYTHONUNBUFFERED: "1",
    }).map(([k, v]) => `${k}=${v}`);

    const remoteScript = buildRemoteShellCommand({
      cmdArgs: task.command,
      cwd: effectiveCwd,
      envVars: envPairs,
    });

    appendTaskLog(
      task.id,
      `[task ${task.id}] started at ${new Date().toISOString()} on ${session.name} (${session.gpu?.name || "GPU"})\n$ ${task.command.join(" ")}\n`,
      homeDir,
    );

    let exitCode;
    if (!session.ip && session.colabRuntime?.baseUrl && session.colabRuntime?.token) {
      writeTask(
        {
          ...task,
          cwd: effectiveCwd,
          localPid: process.pid,
          status: "running",
        },
        homeDir,
      );
      try {
        const ttyRes = await execCommandOverTty({
          baseUrl: session.colabRuntime.baseUrl,
          proxyToken: session.colabRuntime.token,
          command: remoteScript,
          cwd: effectiveCwd,
          onOutput: (chunk) => {
            appendTaskLog(task.id, chunk, homeDir);
            if (streamToStdout) {
              stdout.write(chunk);
            }
          },
        });
        exitCode = ttyRes.exitCode;
      } catch (err) {
        appendTaskLog(
          task.id,
          `\n[task ${task.id}] colab-tty error: ${err instanceof Error ? err.message : String(err)}\n`,
          homeDir,
        );
        exitCode = 1;
      }
    } else {
      const sshArgs = buildSshExecArgs({
        ip: session.ip,
        remoteCommand: [remoteScript],
        homeDir,
        tty: false,
      });

      exitCode = await new Promise((resolve) => {
        const child = spawnChild("ssh", sshArgs, {
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });

        writeTask(
          {
            ...task,
            cwd: effectiveCwd,
            localPid: child.pid || process.pid,
            status: "running",
          },
          homeDir,
        );

        child.stdout?.on("data", (chunk) => {
          const text = chunk.toString("utf8");
          appendTaskLog(task.id, text, homeDir);
          if (streamToStdout) {
            stdout.write(text);
          }
        });

        child.stderr?.on("data", (chunk) => {
          const text = chunk.toString("utf8");
          appendTaskLog(task.id, text, homeDir);
          if (streamToStdout) {
            stderr.write(text);
          }
        });

        child.on("error", (err) => {
          appendTaskLog(
            task.id,
            `\n[task ${task.id}] ssh error: ${err.message}\n`,
            homeDir,
          );
          resolve(1);
        });

        child.on("close", (code, sig) => {
          if (typeof code === "number") {
            resolve(code);
          } else if (sig) {
            resolve(143);
          } else {
            resolve(1);
          }
        });
      });
    }

    const latest = readTask(task.id, homeDir, { reconcile: false }) || task;
    if (latest.status === "stopped") {
      return EXIT_OK;
    }

    const finishedAt = new Date().toISOString();
    const finalStatus = exitCode === 0 ? "succeeded" : "failed";
    appendTaskLog(
      task.id,
      `\n[task ${task.id}] ${finalStatus} at ${finishedAt} (exit code ${exitCode})\n`,
      homeDir,
    );
    writeTask(
      {
        ...latest,
        cwd: effectiveCwd,
        status: finalStatus,
        exitCode,
        finishedAt,
      },
      homeDir,
    );
    return exitCode;
  };

  if (withActivity) {
    return await withActivity(session.name, homeDir, runCore);
  }
  return await runCore();
}

export async function submitTask(
  {
    name,
    command,
    sessionName,
    cwd: remoteCwd = null,
    envVars = {},
    syncPath = null,
    wait = false,
  },
  {
    homeDir = os.homedir(),
    localCwd = process.cwd(),
    env = process.env,
    spawnChild = spawn,
    stdout = process.stdout,
    stderr = process.stderr,
    streamToStdout = false,
    nowMs = () => Date.now(),
    nowIso = () => new Date().toISOString(),
  } = {},
) {
  const session = resolveSession({
    sessionName: sessionName ?? null,
    homeDir,
  });

  const cmdArray = Array.isArray(command)
    ? command.map(String)
    : typeof command === "string" && command.trim()
      ? [command.trim()]
      : [];

  if (cmdArray.length === 0) {
    throw new CliError(
      "missing task command (usage: orca-colab job submit [--name N] [--sync] -- <cmd...>)",
    );
  }

  const id = generateTaskId(nowMs());
  const createdAt = nowIso();
  const initialTask = writeTask(
    {
      id,
      name: name || cmdArray.join(" ").slice(0, 64),
      command: cmdArray,
      sessionName: session.name,
      account: session.account || "default",
      cwd: remoteCwd || session.remoteRoot || null,
      env: envVars,
      syncPath,
      status: "running",
      exitCode: null,
      createdAt,
      startedAt: createdAt,
      finishedAt: null,
      localPid: process.pid,
    },
    homeDir,
  );

  if (wait) {
    const exitCode = await executeTaskInline(initialTask.id, {
      homeDir,
      cwd: localCwd,
      env,
      spawnChild,
      streamToStdout,
      stdout,
      stderr,
    });
    const finalTask = readTask(initialTask.id, homeDir);
    return { task: finalTask, exitCode };
  }

  const child = spawnChild(
    process.execPath,
    [CLI_ENTRY_PATH, "job", "--internal-exec", initialTask.id, "--home-dir", homeDir],
    {
      cwd: localCwd,
      env,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref?.();

  const updatedTask = writeTask(
    {
      ...initialTask,
      localPid: child.pid || null,
    },
    homeDir,
  );

  return { task: updatedTask, exitCode: EXIT_OK };
}

export function stopTaskById(
  taskId,
  {
    homeDir = os.homedir(),
    runSsh = null,
    killProcess = (pid) => {
      try {
        process.kill(pid, "SIGTERM");
        return true;
      } catch {
        return false;
      }
    },
    nowIso = () => new Date().toISOString(),
  } = {},
) {
  const task = readTask(taskId, homeDir, { reconcile: false });
  if (!task) {
    throw new CliError(`task not found: ${taskId}`);
  }

  if (task.status !== "running") {
    return task;
  }

  const session = readSession(task.sessionName, homeDir);
  if (session?.ip) {
    try {
      execSshCapture({
        ip: session.ip,
        remoteCommand: `pkill -TERM -f "ORCA_TASK_ID=${task.id}" || true`,
        homeDir,
        timeoutMs: 6000,
        runSsh,
      });
    } catch {
      // Ignore remote pkill failure if session already closed.
    }
  } else if (session?.colabRuntime?.baseUrl && session?.colabRuntime?.token) {
    execCommandOverTty({
      baseUrl: session.colabRuntime.baseUrl,
      proxyToken: session.colabRuntime.token,
      command: `pkill -TERM -f "ORCA_TASK_ID=${task.id}" || true`,
      timeoutMs: 6000,
    }).catch(() => {});
  }

  if (task.localPid && task.localPid !== process.pid) {
    killProcess(task.localPid);
  }

  const finishedAt = nowIso();
  appendTaskLog(task.id, `\n[task ${task.id}] stopped by user at ${finishedAt}\n`, homeDir);
  return writeTask(
    {
      ...task,
      status: "stopped",
      exitCode: 130,
      finishedAt,
    },
    homeDir,
  );
}

export async function run(
  argv,
  {
    json = false,
    stdout = process.stdout,
    stderr = process.stderr,
    cwd = process.cwd(),
    env = process.env,
    homeDir = os.homedir(),
    spawnChild = spawn,
    runSsh = null,
  } = {},
) {
  const dashDash = argv.indexOf("--");
  const headArgs = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const tailArgs = dashDash === -1 ? [] : argv.slice(dashDash + 1);

  let parsed;
  try {
    parsed = parseArgs({
      args: headArgs,
      options: {
        session: { type: "string" },
        name: { type: "string" },
        cwd: { type: "string" },
        env: { type: "string", multiple: true },
        sync: { type: "boolean", default: false },
        "sync-path": { type: "string" },
        wait: { type: "boolean", default: false },
        status: { type: "string" },
        tail: { type: "string", default: "200" },
        follow: { type: "boolean", default: false },
        "internal-exec": { type: "string" },
        "home-dir": { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const opts = parsed.values;
  const effectiveHomeDir = opts["home-dir"] || homeDir;

  if (opts["internal-exec"]) {
    return await executeTaskInline(opts["internal-exec"], {
      homeDir: effectiveHomeDir,
      cwd,
      env,
      spawnChild,
      streamToStdout: false,
    });
  }

  const subcommand = parsed.positionals[0] || "ls";

  if (subcommand === "submit") {
    const cmdArgs =
      tailArgs.length > 0 ? tailArgs : parsed.positionals.slice(1);
    const envMap = {};
    for (const pair of opts.env ?? []) {
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        throw new CliError(`invalid --env value '${pair}' (expected KEY=VALUE)`);
      }
      envMap[pair.slice(0, eq)] = pair.slice(eq + 1);
    }

    const syncPath = opts["sync-path"]
      ? opts["sync-path"]
      : opts.sync
        ? cwd
        : null;

    const { task, exitCode } = await submitTask(
      {
        name: opts.name,
        command: cmdArgs,
        sessionName: opts.session,
        cwd: opts.cwd,
        envVars: envMap,
        syncPath,
        wait: Boolean(opts.wait),
      },
      {
        homeDir: effectiveHomeDir,
        localCwd: cwd,
        env,
        spawnChild,
        stdout,
        stderr,
        streamToStdout: Boolean(opts.wait && !json),
      },
    );

    if (json) {
      const logSnapshot = readTaskLog(task.id, effectiveHomeDir, { tailLines: 100 });
      writeJson(
        {
          ok: exitCode === 0,
          task,
          ...(opts.wait ? { output: logSnapshot.text } : {}),
        },
        stdout,
      );
    } else {
      log(
        `Task ${task.id} (${task.name}) ${task.status} on ${task.sessionName}. View output: orca-colab job logs ${task.id}`,
        stderr,
      );
    }
    return exitCode;
  }

  if (subcommand === "ls" || subcommand === "list") {
    let tasks = listTasks(effectiveHomeDir);
    if (opts.session) {
      tasks = tasks.filter((t) => t.sessionName === opts.session);
    }
    if (opts.status) {
      tasks = tasks.filter((t) => t.status === opts.status);
    }

    if (json) {
      writeJson({ tasks }, stdout);
      return EXIT_OK;
    }

    if (tasks.length === 0) {
      log("No tasks submitted yet.", stderr);
      return EXIT_OK;
    }

    for (const t of tasks) {
      stdout.write(
        `${t.id}\t${t.status.toUpperCase()}\t${t.sessionName}\t${t.name}\n`,
      );
    }
    return EXIT_OK;
  }

  if (subcommand === "logs" || subcommand === "log") {
    const taskId = parsed.positionals[1];
    if (!taskId) {
      throw new CliError("usage: orca-colab job logs <task-id> [--tail N] [--follow]");
    }
    const tailLines = Number.parseInt(opts.tail || "200", 10);
    const task = readTask(taskId, effectiveHomeDir);
    if (!task) {
      throw new CliError(`task not found: ${taskId}`);
    }

    const logData = readTaskLog(task.id, effectiveHomeDir, {
      tailLines: Number.isFinite(tailLines) ? tailLines : 200,
    });

    if (json) {
      writeJson(
        {
          ok: true,
          task,
          output: logData.text,
          totalBytes: logData.totalBytes,
          truncated: logData.truncated,
        },
        stdout,
      );
      return EXIT_OK;
    }

    if (logData.text) {
      stdout.write(logData.text);
      if (!logData.text.endsWith("\n")) {
        stdout.write("\n");
      }
    }

    if (opts.follow && task.status === "running") {
      let lastBytes = logData.totalBytes;
      while (true) {
        await new Promise((r) => setTimeout(r, 500));
        const currentTask = readTask(task.id, effectiveHomeDir);
        const nextLog = readTaskLog(task.id, effectiveHomeDir, { tailLines: 0 });
        if (nextLog.totalBytes > lastBytes) {
          const delta = nextLog.text.slice(nextLog.text.length - (nextLog.totalBytes - lastBytes));
          stdout.write(delta);
          lastBytes = nextLog.totalBytes;
        }
        if (!currentTask || currentTask.status !== "running") {
          break;
        }
      }
    }

    return EXIT_OK;
  }

  if (subcommand === "stop" || subcommand === "kill") {
    const taskId = parsed.positionals[1];
    if (!taskId) {
      throw new CliError("usage: orca-colab job stop <task-id>");
    }
    const stopped = stopTaskById(taskId, {
      homeDir: effectiveHomeDir,
      runSsh,
    });
    if (json) {
      writeJson({ ok: true, task: stopped }, stdout);
    } else {
      log(`Stopped task ${stopped.id} (${stopped.name}).`, stderr);
    }
    return EXIT_OK;
  }

  throw new CliError(
    `unknown job subcommand '${subcommand}' (expected 'submit', 'ls', 'logs', or 'stop')`,
  );
}
