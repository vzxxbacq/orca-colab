import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_OK,
  EXIT_ZOMBIE,
  log,
  writeJson,
} from "../lib/cli-output.mjs";
import { recordSessionEndEvent } from "../lib/credit-ledger.mjs";
import { deleteRuntime as defaultDeleteRuntime } from "../lib/colab-api-client.mjs";
import { getValidAccessToken } from "../lib/colab-oauth.mjs";
import {
  deleteSession,
  listSessions,
  readSession,
  selectDefaultSession,
  writeSession,
} from "../lib/session-store.mjs";
import { waitForSshPortClosed } from "../lib/ssh-banner-probe.mjs";
import { execSshCapture } from "../lib/ssh-exec.mjs";

function defaultKillPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export async function run(
  argv,
  {
    json,
    stdout,
    stderr,
    homeDir,
    signal = null,
    runSsh = null,
    waitPortClosed = waitForSshPortClosed,
    killPid = defaultKillPid,
    onSessionEnd = recordSessionEndEvent,
    deleteRuntimeFn = defaultDeleteRuntime,
    fetchImpl = fetch,
    waitTimeoutMs = 30_000,
    nowIso = () => new Date().toISOString(),
  },
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        session: { type: "string" },
        all: { type: "boolean", default: false },
        cause: { type: "string", default: "user" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const opts = parsed.values;
  const allSessions = listSessions(homeDir);
  let targets = [];

  if (opts.all) {
    targets = allSessions;
  } else if (opts.session) {
    const found = readSession(opts.session, homeDir);
    if (found) {
      targets = [found];
    }
  } else if (allSessions.length > 0) {
    targets = [selectDefaultSession(allSessions)];
  }

  if (targets.length === 0) {
    log("No active session to stop (already gone).", stderr);
    if (json) {
      writeJson(
        opts.all
          ? { ok: true, released: true, sessions: [] }
          : {
              ok: true,
              session: opts.session ?? null,
              released: true,
              reason: "already-gone",
            },
        stdout,
      );
    }
    return EXIT_OK;
  }

  const results = [];
  let anyZombie = false;

  for (const session of targets) {
    for (const fwd of session.forwards) {
      if (fwd.pid) {
        killPid(fwd.pid);
      }
    }

    let deletedByApi = false;
    if (session.colabRuntime?.id) {
      try {
        const accessToken = await getValidAccessToken({
          account: session.account || "default",
          homeDir,
          fetchImpl,
        });
        if (accessToken) {
          await deleteRuntimeFn({
            runtimeId: session.colabRuntime.id,
            accessToken,
            fetchImpl,
            signal,
          });
          deletedByApi = true;
        }
      } catch {
        // Fall through to SSH sentinel + port check if API call fails.
      }
    }

    if (session.ip) {
      try {
        execSshCapture({
          ip: session.ip,
          remoteCommand:
            "mkdir -p /root/.orca-colab && touch /root/.orca-colab/unassign",
          homeDir,
          timeoutMs: 8000,
          runSsh,
        });
      } catch {
        // Proceed to port check even if SSH failed because runtime already died.
      }
    }

    const closed = deletedByApi
      ? true
      : session.ip
        ? await waitPortClosed({
            host: session.ip,
            port: 22,
            timeoutMs: waitTimeoutMs,
            signal,
          })
        : true;

    if (closed) {
      deleteSession(session.name, homeDir);
      const endedAt = nowIso();
      if (onSessionEnd) {
        await onSessionEnd(session, {
          cause: opts.cause ?? "user",
          endedAt,
          homeDir,
        });
      }
      log(`Released session ${session.name}.`, stderr);
      results.push({
        ok: true,
        session: session.name,
        released: true,
      });
    } else {
      anyZombie = true;
      writeSession(
        {
          ...session,
          state: "zombie",
          forwards: [],
          lastActivityAt: nowIso(),
        },
        homeDir,
      );
      const action =
        "Open the Colab notebook tab and choose Runtime -> Disconnect and delete runtime.";
      log(
        `warning: ${session.name} (${session.ip}) did not close port 22 within 30s; marked state=zombie. ${action}`,
        stderr,
      );
      results.push({
        ok: false,
        session: session.name,
        released: false,
        state: "zombie",
        reason: "port-22-still-open",
        action,
      });
    }
  }

  if (json) {
    if (opts.all || results.length > 1) {
      writeJson(
        {
          ok: !anyZombie,
          released: !anyZombie,
          sessions: results,
        },
        stdout,
      );
    } else {
      writeJson(results[0], stdout);
    }
  }

  return anyZombie ? EXIT_ZOMBIE : EXIT_OK;
}
