import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_OK,
  log,
  writeJson,
} from "../lib/cli-output.mjs";
import { withSessionActivity } from "../lib/session-activity.mjs";
import {
  readSession,
  resolveSession,
  writeSession,
} from "../lib/session-store.mjs";
import { buildSshBaseArgs } from "../lib/ssh-exec.mjs";

function parsePortSpec(spec) {
  const parts = String(spec ?? "").split(":");
  if (parts.length < 1 || parts.length > 2) {
    throw new CliError(`invalid port specification: ${spec}`);
  }
  const localPort = Number.parseInt(parts[0], 10);
  const remotePort =
    parts.length === 2 ? Number.parseInt(parts[1], 10) : localPort;
  if (
    !Number.isInteger(localPort) ||
    localPort < 1 ||
    localPort > 65535 ||
    !Number.isInteger(remotePort) ||
    remotePort < 1 ||
    remotePort > 65535
  ) {
    throw new CliError(`invalid port specification: ${spec}`);
  }
  return { localPort, remotePort };
}

export function buildSshForwardArgs({
  ip,
  localPort,
  remotePort = localPort,
  homeDir,
}) {
  return [
    ...buildSshBaseArgs({
      homeDir,
      extraArgs: [
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      ],
    }),
    `root@${ip}`,
  ];
}

function defaultKillPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function defaultSpawnDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid };
}

export async function run(
  argv,
  {
    json,
    stdout,
    stderr,
    homeDir,
    spawnDetached = defaultSpawnDetached,
    killPid = defaultKillPid,
    withActivity = withSessionActivity,
  },
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        session: { type: "string" },
        stop: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const opts = parsed.values;
  const session = resolveSession({
    sessionName: opts.session ?? null,
    homeDir,
  });

  const execute = async () => {
    const fresh = readSession(session.name, homeDir) ?? session;
    if (opts.stop !== undefined) {
      const stopPort = Number.parseInt(opts.stop, 10);
      if (!Number.isInteger(stopPort) || stopPort < 1 || stopPort > 65535) {
        throw new CliError(`invalid --stop port: ${opts.stop}`);
      }
      const matching = fresh.forwards.filter((f) => f.port === stopPort);
      for (const f of matching) {
        if (f.pid) {
          killPid(f.pid);
        }
      }
      const remaining = fresh.forwards.filter((f) => f.port !== stopPort);
      writeSession({ ...fresh, forwards: remaining }, homeDir);
      log(`Stopped port forward on localhost:${stopPort}.`, stderr);
      if (json) {
        writeJson(
          {
            ok: true,
            session: fresh.name,
            stopped: true,
            port: stopPort,
          },
          stdout,
        );
      }
      return EXIT_OK;
    }

    const spec = parsed.positionals[0];
    if (!spec) {
      throw new CliError(
        "usage: orca-colab forward [--session N] <port>[:<remotePort>] | --stop <port>",
      );
    }
    const { localPort, remotePort } = parsePortSpec(spec);

    for (const existing of fresh.forwards) {
      if (existing.port === localPort && existing.pid) {
        killPid(existing.pid);
      }
    }

    const sshArgs = buildSshForwardArgs({
      ip: fresh.ip,
      localPort,
      remotePort,
      homeDir,
    });
    const { pid } = spawnDetached("ssh", sshArgs);
    if (!Number.isInteger(pid)) {
      throw new CliError("failed to spawn background ssh port forward");
    }

    const forwards = [
      ...fresh.forwards.filter((f) => f.port !== localPort),
      { port: localPort, remotePort, pid },
    ];
    writeSession({ ...fresh, forwards }, homeDir);

    const url = `http://localhost:${localPort}`;
    log(
      `Forwarding ${url} -> ${fresh.name}:${remotePort} (pid ${pid}).`,
      stderr,
    );
    if (json) {
      writeJson(
        {
          ok: true,
          session: fresh.name,
          port: localPort,
          remotePort,
          pid,
          url,
        },
        stdout,
      );
    } else {
      stdout.write(`${url}\n`);
    }
    return EXIT_OK;
  };

  if (withActivity) {
    return withActivity(session.name, homeDir, execute);
  }
  return execute();
}
