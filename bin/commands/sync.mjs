import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_ERROR,
  EXIT_OK,
  log,
  writeJson,
} from "../lib/cli-output.mjs";
import { execCommandOverTty } from "../lib/colab-api-client.mjs";
import { readConfig } from "../lib/colab-home.mjs";
import {
  resolveRemoteRoot,
  runSyncTransfer,
} from "../lib/file-transfer.mjs";
import { withSessionActivity } from "../lib/session-activity.mjs";
import { resolveSession, writeSession } from "../lib/session-store.mjs";
import { shellQuote } from "./run.mjs";

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

    let res;
    if (!session.ip && session.colabRuntime?.baseUrl && session.colabRuntime?.token) {
      const resolvedLocal = path.resolve(localDir);
      const tarArgs = ["-czf", "-", "--exclude=.git"];
      if (existsSync(path.join(resolvedLocal, ".gitignore"))) {
        tarArgs.push(`--exclude-from=${path.join(resolvedLocal, ".gitignore")}`);
      }
      if (existsSync(path.join(resolvedLocal, ".colabignore"))) {
        tarArgs.push(`--exclude-from=${path.join(resolvedLocal, ".colabignore")}`);
      }
      tarArgs.push("-C", resolvedLocal, ".");

      const spawnFn = spawnProcess ?? spawnSync;
      const tarRes = spawnFn("tar", tarArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
      });

      if (tarRes?.status !== 0) {
        res = {
          ok: false,
          method: "colab-tty-tar",
          exitCode: tarRes?.status ?? 1,
          stderr: tarRes?.stderr ? tarRes.stderr.toString("utf8") : "tar failed",
        };
      } else {
        const cleanRemote = remoteRoot.replace(/\/+$/, "");
        const ttyRes = await execCommandOverTty({
          baseUrl: session.colabRuntime.baseUrl,
          proxyToken: session.colabRuntime.token,
          command: `mkdir -p ${shellQuote(cleanRemote)} && tar -xzf - -C ${shellQuote(cleanRemote)}`,
          stdinBase64: Buffer.from(tarRes.stdout).toString("base64"),
        });
        res = {
          ok: ttyRes.ok,
          method: "colab-tty-tar",
          exitCode: ttyRes.exitCode,
          stderr: ttyRes.stdout || "",
        };
      }
    } else {
      res = runSyncTransfer({
        localDir,
        ip: session.ip,
        remoteRoot,
        homeDir,
        env,
        ...(findBinary ? { findBinary } : {}),
        ...(spawnProcess ? { spawnProcess } : {}),
      });
    }

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
