import path from "node:path";
import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_ERROR,
  EXIT_OK,
  log,
  writeJson,
} from "../lib/cli-output.mjs";
import { runPullTransfer } from "../lib/file-transfer.mjs";
import { withSessionActivity } from "../lib/session-activity.mjs";
import { resolveSession } from "../lib/session-store.mjs";

export async function run(
  argv,
  {
    json,
    stdout,
    stderr,
    env,
    cwd,
    homeDir,
    findBinary = undefined,
    spawnProcess = undefined,
    withActivity = withSessionActivity,
  },
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        session: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const [rawRemotePath, rawLocalPath] = parsed.positionals;
  if (!rawRemotePath || !rawLocalPath) {
    throw new CliError(
      "usage: orca-colab pull [--session N] <remotePath> <localPath>",
    );
  }

  const session = resolveSession({
    sessionName: parsed.values.session ?? null,
    homeDir,
  });

  const remotePath =
    rawRemotePath.startsWith("/") || !session.remoteRoot
      ? rawRemotePath
      : path.posix.join(session.remoteRoot, rawRemotePath);
  const localPath = path.resolve(cwd, rawLocalPath);

  const execute = async () => {
    log(`Pulling ${session.name}:${remotePath} -> ${localPath}...`, stderr);
    const res = runPullTransfer({
      ip: session.ip,
      remotePath,
      localPath,
      homeDir,
      env,
      ...(findBinary ? { findBinary } : {}),
      ...(spawnProcess ? { spawnProcess } : {}),
    });

    if (!res.ok) {
      throw new CliError(
        `pull failed (${res.method}, exit ${res.exitCode})${res.stderr ? `: ${res.stderr.trim()}` : ""}`,
        { exitCode: EXIT_ERROR },
      );
    }

    log(`Pulled ${remotePath} -> ${localPath} via ${res.method}.`, stderr);
    if (json) {
      writeJson(
        {
          ok: true,
          session: session.name,
          remotePath,
          localPath,
          method: res.method,
        },
        stdout,
      );
    }
    return EXIT_OK;
  };

  if (withActivity) {
    return withActivity(session.name, homeDir, execute);
  }
  return execute();
}
