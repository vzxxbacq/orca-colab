import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_OK,
  EXIT_ZOMBIE,
  log,
  writeJson,
} from "../lib/cli-output.mjs";
import {
  recordCalibrateEvent,
  recordSessionEndEvent,
} from "../lib/credit-ledger.mjs";
import {
  deleteRuntime as defaultDeleteRuntime,
  getConsumptionUserInfo as defaultGetConsumptionUserInfo,
} from "../lib/colab-api-client.mjs";
import { getValidAccessToken } from "../lib/colab-oauth.mjs";
import {
  deleteSession,
  listSessions,
  readSession,
  selectDefaultSession,
  writeSession,
} from "../lib/session-store.mjs";

export async function run(
  argv,
  {
    json,
    stdout,
    stderr,
    homeDir,
    signal = null,
    onSessionEnd = recordSessionEndEvent,
    deleteRuntimeFn = defaultDeleteRuntime,
    fetchImpl = fetch,
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
    let deletedByApi = false;
    let apiAccessToken = null;
    if (session.colabRuntime?.id) {
      try {
        const accessToken = await getValidAccessToken({
          account: session.account || "default",
          homeDir,
          fetchImpl,
        });
        if (accessToken) {
          apiAccessToken = accessToken;
          await deleteRuntimeFn({
            runtimeId: session.colabRuntime.id,
            accessToken,
            fetchImpl,
            signal,
          });
          deletedByApi = true;
        }
      } catch {
        // Reported below as a zombie the user can delete in Colab.
      }
    }

    // Sessions from the old Tailscale flow have no runtime id to delete; only the local record is left.
    const closed = deletedByApi || !session.colabRuntime?.id;

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
      if (deletedByApi && apiAccessToken && deleteRuntimeFn === defaultDeleteRuntime) {
        try {
          const ccu = await defaultGetConsumptionUserInfo({
            accessToken: apiAccessToken,
            fetchImpl,
            signal,
          });
          if (typeof ccu.paidComputeUnitsBalance === "number") {
            recordCalibrateEvent(
              {
                account: session.account || "default",
                balanceCu: ccu.paidComputeUnitsBalance,
                consumptionRateHourly: ccu.consumptionRateHourly,
                assignmentsCount: ccu.assignmentsCount,
                source: "colab-api",
                at: endedAt,
              },
              homeDir,
            );
          }
        } catch {
          // Best-effort post-session CCU calibration.
        }
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
          lastActivityAt: nowIso(),
        },
        homeDir,
      );
      const action =
        "Run 'orca-colab auth login' and retry 'orca-colab down', or delete the runtime at colab.research.google.com (Runtime -> Disconnect and delete runtime).";
      log(
        `warning: could not release ${session.name} through the Colab API; marked state=zombie. ${action}`,
        stderr,
      );
      results.push({
        ok: false,
        session: session.name,
        released: false,
        state: "zombie",
        reason: "api-delete-failed",
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
