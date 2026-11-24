import { parseArgs } from "node:util";
import { discoverAccountRuntimes } from "../lib/account-runtimes.mjs";
import { CliError, EXIT_OK, log, writeJson } from "../lib/cli-output.mjs";
import { listRecentSessionEnds } from "../lib/credit-ledger.mjs";
import { liveForwards } from "../lib/port-forward.mjs";
import { listSessions } from "../lib/session-store.mjs";

export function describeSessionOrigin(session) {
  if (!session.adopted) return "this machine";
  if (!session.origin) return "unknown origin";
  return `${session.origin.agent && session.origin.agent !== "cli" ? `${session.origin.agent} on ` : ""}${session.origin.machine}`;
}

export async function run(
  argv,
  {
    json,
    stdout,
    stderr,
    env = process.env,
    homeDir,
    fetchImpl = fetch,
    discover = discoverAccountRuntimes,
    nowMs = () => Date.now(),
  },
) {
  let opts;
  try {
    opts = parseArgs({
      args: argv,
      options: {
        local: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  // The account's runtimes at Colab, including ones started from other machines; --local skips the call.
  if (!opts.local) {
    await discover({ homeDir, env, fetchImpl }).catch(() => {});
  }
  const sessions = listSessions(homeDir);
  const now = nowMs();

  const enriched = sessions.map((session) => {
    const createdMs = Date.parse(session.createdAt);
    const ageSeconds = Number.isNaN(createdMs)
      ? 0
      : Math.max(0, Math.floor((now - createdMs) / 1000));
    // The proxy token lets anyone holding it drive the runtime; it stays in the session file only.
    const { token: _omitToken, ...colabRuntime } = session.colabRuntime || {};
    return {
      ...session,
      ...(session.colabRuntime ? { colabRuntime } : {}),
      forwards: liveForwards(session),
      origin: session.origin ?? null,
      startedHere: !session.adopted,
      reachable: Boolean(session.colabRuntime?.baseUrl) && session.state !== "zombie",
      ageSeconds,
    };
  });

  const recentlyEnded = listRecentSessionEnds(homeDir, { nowMs: now });
  if (json) {
    writeJson({ sessions: enriched, recentlyEnded }, stdout);
    return EXIT_OK;
  }

  for (const ended of recentlyEnded) {
    log(`ended ${ended.endedAt}: ${ended.session} (${ended.cause}). ${ended.reason}`, stderr);
  }
  if (enriched.length === 0) {
    log("No sessions.", stderr);
    return EXIT_OK;
  }

  for (const s of enriched) {
    const gpuLabel = s.gpu?.name ?? "unknown";
    log(
      `${s.name} (account=${s.account}) gpu="${gpuLabel}" reachable=${s.reachable} state=${s.state} age=${s.ageSeconds}s started-by="${describeSessionOrigin(s)}"`,
      stderr,
    );
    for (const f of s.forwards) {
      log(`  forward http://${f.listen} -> port ${f.remotePort} (pid ${f.pid})`, stderr);
    }
  }
  return EXIT_OK;
}
