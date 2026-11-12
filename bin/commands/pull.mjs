import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
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
import { downloadJupyterFile } from "../lib/jupyter-files.mjs";
import { withSessionActivity } from "../lib/session-activity.mjs";
import { requireColabRuntime, resolveSession } from "../lib/session-store.mjs";
import { shellQuote } from "./run.mjs";

export async function run(
  argv,
  {
    json,
    stdout,
    stderr,
    cwd,
    homeDir,
    spawnProcess = spawnSync,
    execTty = execCommandOverTty,
    fetchImpl = fetch,
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

  const { baseUrl, proxyToken } = requireColabRuntime(session);

  // The tty mangles binary output, so the runtime packs the path into /tmp and Jupyter serves the archive.
  const execute = async () => {
    log(`Pulling ${session.name}:${remotePath} -> ${localPath}...`, stderr);
    const remoteArchive = `/tmp/orca-colab-pull-${randomBytes(6).toString("hex")}.tar.gz`;
    const localTmp = mkdtempSync(path.join(os.tmpdir(), "orca-colab-pull-"));
    const localArchive = path.join(localTmp, "pull.tar.gz");
    const method = "jupyter-files";
    let res;
    try {
      const parent = path.posix.dirname(remotePath);
      const base = path.posix.basename(remotePath);
      const packed = await execTty({
        baseUrl,
        proxyToken,
        command: `tar -czf ${shellQuote(remoteArchive)} -C ${shellQuote(parent)} ${shellQuote(base)}`,
      });
      if (packed.exitCode !== 0) {
        res = { ok: false, method, exitCode: packed.exitCode, stderr: packed.stdout || "" };
      } else {
        await downloadJupyterFile({ baseUrl, proxyToken, remotePath: remoteArchive, destPath: localArchive, fetchImpl });
        mkdirSync(localPath, { recursive: true });
        const untar = spawnProcess("tar", ["-xzf", localArchive, "-C", localPath], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        res = {
          ok: untar?.status === 0,
          method,
          exitCode: untar?.status ?? 1,
          stderr: untar?.stderr ? untar.stderr.toString("utf8") : "",
        };
      }
    } finally {
      rmSync(localTmp, { recursive: true, force: true });
      await execTty({ baseUrl, proxyToken, command: `rm -f ${shellQuote(remoteArchive)}` }).catch(() => {});
    }

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
