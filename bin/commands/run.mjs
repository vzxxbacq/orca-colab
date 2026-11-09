import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { CliError, writeJson } from "../lib/cli-output.mjs";
import { withSessionActivity } from "../lib/session-activity.mjs";
import { resolveSession } from "../lib/session-store.mjs";
import { buildSshExecArgs } from "../lib/ssh-exec.mjs";

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
    spawnSsh = spawnSync,
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

  const sshArgs = buildSshExecArgs({
    ip: session.ip,
    remoteCommand: [remoteScript],
    homeDir,
    tty: Boolean(stdinIsTTY && !json && !opts.detach),
  });

  const execute = async () => {
    const res = spawnSsh("ssh", sshArgs, {
      encoding: "utf8",
      stdio: json ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const exitCode = typeof res?.status === "number" ? res.status : 1;
    if (json) {
      writeJson(
        {
          ok: exitCode === 0,
          session: session.name,
          exitCode,
          stdout: res?.stdout ?? "",
          stderr: res?.stderr ?? "",
        },
        stdout,
      );
    } else if (res?.stderr && typeof res.stderr === "string") {
      stderr.write(res.stderr);
    }
    return exitCode;
  };

  if (withActivity) {
    return withActivity(session.name, homeDir, execute);
  }
  return execute();
}
