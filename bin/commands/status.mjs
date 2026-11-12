import { EXIT_OK, log, writeJson } from "../lib/cli-output.mjs";
import { listSessions } from "../lib/session-store.mjs";

export async function run(
  _argv,
  {
    json,
    stdout,
    stderr,
    homeDir,
    nowMs = () => Date.now(),
  },
) {
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
      reachable: Boolean(session.colabRuntime?.baseUrl) && session.state !== "zombie",
      ageSeconds,
    };
  });

  if (json) {
    writeJson({ sessions: enriched }, stdout);
    return EXIT_OK;
  }

  if (enriched.length === 0) {
    log("No sessions.", stderr);
    return EXIT_OK;
  }

  for (const s of enriched) {
    const gpuLabel = s.gpu?.name ?? "unknown";
    log(
      `${s.name} (account=${s.account}) gpu="${gpuLabel}" reachable=${s.reachable} state=${s.state} age=${s.ageSeconds}s`,
      stderr,
    );
  }
  return EXIT_OK;
}
