import { EXIT_OK, log, writeJson } from "../lib/cli-output.mjs";
import { listSessions } from "../lib/session-store.mjs";
import { probeSshBannerOnce } from "../lib/ssh-banner-probe.mjs";

export async function run(
  _argv,
  {
    json,
    stdout,
    stderr,
    homeDir,
    probeOnce = probeSshBannerOnce,
    nowMs = () => Date.now(),
  },
) {
  const sessions = listSessions(homeDir);
  const now = nowMs();

  const enriched = await Promise.all(
    sessions.map(async (session) => {
      const probe = session.ip
        ? await probeOnce({ host: session.ip, port: 22, timeoutMs: 3000 })
        : { ok: false, reason: "no-ip" };
      const createdMs = Date.parse(session.createdAt);
      const ageSeconds = Number.isNaN(createdMs)
        ? 0
        : Math.max(0, Math.floor((now - createdMs) / 1000));
      return {
        ...session,
        reachable: Boolean(probe.ok),
        ageSeconds,
      };
    }),
  );

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
      `${s.name} (account=${s.account}) ip=${s.ip} gpu="${gpuLabel}" reachable=${s.reachable} state=${s.state} age=${s.ageSeconds}s`,
      stderr,
    );
  }
  return EXIT_OK;
}
