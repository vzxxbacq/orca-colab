import path from "node:path";
import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_ERROR,
  EXIT_OK,
  log,
  writeJson,
} from "../lib/cli-output.mjs";
import { readConfig } from "../lib/colab-home.mjs";
import {
  resolveRemoteRoot,
  runSyncTransfer,
} from "../lib/file-transfer.mjs";
import { resolveSession, writeSession } from "../lib/session-store.mjs";

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
    withActivity = null,
  },
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        session: { type: "string" },
        to: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const opts = parsed.values;
  const localArg = parsed.positionals[0] ?? ".";
  const localDir = path.resolve(cwd, localArg);

  const session = resolveSession({
    sessionName: opts.session ?? null,
    homeDir,
  });
  const config = readConfig(homeDir);
  const remoteRoot = resolveRemoteRoot({
    localPath: localDir,
    toDir: opts.to ?? null,
    remoteRootBase: config?.remoteRootBase ?? "/content/orca",
  });

  const execute = async () => {
    log(
      `Syncing ${localDir} -> ${session.name}:${remoteRoot}...`,
      stderr,
    );
    const res = runSyncTransfer({
      localDir,
      ip: session.ip,
      remoteRoot,
      homeDir,
      env,
      ...(findBinary ? { findBinary } : {}),
      ...(spawnProcess ? { spawnProcess } : {}),
    });

    if (!res.ok) {
      throw new CliError(
        `sync failed (${res.method}, exit ${res.exitCode})${res.stderr ? `: ${res.stderr.trim()}` : ""}`,
        { exitCode: EXIT_ERROR },
      );
    }

    const updated = writeSession(
      {
        ...session,
        remoteRoot,
      },
      homeDir,
    );

    log(`Synced to ${remoteRoot} via ${res.method}.`, stderr);
    if (json) {
      writeJson(
        {
          ok: true,
          session: updated.name,
          localPath: localDir,
          remoteRoot,
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
