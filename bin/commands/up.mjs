import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_ABORTED,
  EXIT_ERROR,
  EXIT_OK,
  log,
  writeJson,
} from "../lib/cli-output.mjs";
import { copyToClipboard } from "../lib/clipboard.mjs";
import {
  getColabPaths,
  readConfig,
  resolveAccount,
} from "../lib/colab-home.mjs";
import { BOOTSTRAP_NOTEBOOK_COLAB_URL, openUrl } from "../lib/open-url.mjs";
import { writeSession } from "../lib/session-store.mjs";
import { waitForSshBanner } from "../lib/ssh-banner-probe.mjs";
import { queryRemoteGpu } from "../lib/ssh-exec.mjs";
import { getTailscaleStatus } from "../lib/tailscale-cli.mjs";
import {
  snapshotOnlinePeers,
  waitForColabPeer,
} from "../lib/tailscale-peer-wait.mjs";

const DEFAULT_RATES = {
  T4: 1.96,
  L4: 4.82,
  A100: 11.77,
  "TPU v2-8": 1.76,
  CPU: 0.08,
  unknown: 2,
};

function resolveDefaultRate(gpuName) {
  const upper = String(gpuName ?? "").toUpperCase();
  if (!upper || upper === "CPU") {
    return { rateKey: "CPU", cuPerHour: DEFAULT_RATES.CPU };
  }
  if (upper.includes("T4")) {
    return { rateKey: "T4", cuPerHour: DEFAULT_RATES.T4 };
  }
  if (upper.includes("L4")) {
    return { rateKey: "L4", cuPerHour: DEFAULT_RATES.L4 };
  }
  if (upper.includes("A100")) {
    return { rateKey: "A100", cuPerHour: DEFAULT_RATES.A100 };
  }
  if (upper.includes("TPU")) {
    return { rateKey: "TPU v2-8", cuPerHour: DEFAULT_RATES["TPU v2-8"] };
  }
  return { rateKey: "unknown", cuPerHour: DEFAULT_RATES.unknown };
}

export async function run(
  argv,
  {
    json,
    stdout,
    stderr,
    env,
    homeDir,
    signal = null,
    fetchTailscaleStatus = null,
    probeSshBanner = null,
    runSsh = null,
    openBrowser = openUrl,
    copyClipboard = copyToClipboard,
    resolveGpuRate = resolveDefaultRate,
    onSessionStart = null,
    nowMs = () => Date.now(),
    nowIso = () => new Date().toISOString(),
    sleep = undefined,
    sshPort = 22,
  },
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        name: { type: "string" },
        account: { type: "string" },
        keep: { type: "boolean", default: false },
        timeout: { type: "string", default: "600" },
        "no-open": { type: "boolean", default: false },
        "system-browser": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const opts = parsed.values;
  const timeoutSeconds = Number.parseInt(opts.timeout ?? "600", 10);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new CliError(`invalid --timeout value: ${opts.timeout}`);
  }

  const config = readConfig(homeDir);
  const paths = getColabPaths(homeDir);
  if (
    !config?.authKey ||
    !config.authKey.startsWith("tskey-") ||
    !existsSync(paths.privateKeyPath) ||
    !existsSync(paths.publicKeyPath)
  ) {
    throw new CliError(
      "orca-colab is not configured; run 'orca-colab setup' first",
      {
        exitCode: EXIT_ERROR,
        payload: {
          ok: false,
          error: "orca-colab is not configured; run 'orca-colab setup' first",
          step: "prerequisites",
        },
      },
    );
  }

  const getStatus =
    fetchTailscaleStatus ?? (() => getTailscaleStatus({ env }));
  const initialStatus = await getStatus();
  if (!initialStatus?.found || !initialStatus?.loggedIn) {
    throw new CliError(
      `Tailscale is not running or signed in (state: ${initialStatus?.backendState ?? "NotInstalled"})`,
      {
        exitCode: EXIT_ERROR,
        payload: {
          ok: false,
          error: `Tailscale is not running or signed in (state: ${initialStatus?.backendState ?? "NotInstalled"})`,
          step: "prerequisites",
        },
      },
    );
  }

  if (signal?.aborted) {
    throw new CliError("aborted before starting session", {
      exitCode: EXIT_ABORTED,
      payload: {
        ok: false,
        error: "aborted before starting session",
        step: "init",
      },
    });
  }

  const deadlineMs = nowMs() + timeoutSeconds * 1000;
  const baselinePeers = snapshotOnlinePeers(initialStatus.peers ?? []);
  const account = resolveAccount(config, opts.account);
  const publicKey = readFileSync(paths.publicKeyPath, "utf8").trim();

  if (account.notebookUrl) {
    if (!opts["no-open"]) {
      openBrowser(account.notebookUrl, {
        env,
        systemBrowser: Boolean(opts["system-browser"]),
      });
    }
    log(
      `Opened notebook for account '${account.label}'. Choose a GPU runtime if needed and press Run.`,
      stderr,
    );
  } else {
    const clip = copyClipboard(`${config.authKey} ${publicKey}`, { env });
    if (!opts["no-open"]) {
      openBrowser(BOOTSTRAP_NOTEBOOK_COLAB_URL, {
        env,
        systemBrowser: Boolean(opts["system-browser"]),
      });
    }
    if (clip.copied) {
      log(
        "Opened bootstrap notebook and copied '<authkey> <pubkey>' to clipboard for the PASTE field. Choose a GPU runtime and press Run.",
        stderr,
      );
    } else {
      log(
        "Opened bootstrap notebook (clipboard unavailable; fill the form cell using ~/.orca-colab/config.json and ~/.orca-colab/id_ed25519.pub).",
        stderr,
      );
    }
  }

  log("Waiting for a new online orca-colab-* peer on your tailnet...", stderr);
  const peer = await waitForColabPeer({
    fetchStatus: getStatus,
    baselinePeers,
    expectedName: opts.name ?? null,
    deadlineMs,
    signal,
    now: nowMs,
    ...(sleep ? { sleep } : {}),
  });

  log(
    `Discovered peer ${peer.hostName} (${peer.ipv4}); probing SSH banner...`,
    stderr,
  );
  const probeBanner = probeSshBanner ?? waitForSshBanner;
  await probeBanner({
    host: peer.ipv4,
    port: sshPort,
    deadlineMs,
    signal,
    now: nowMs,
    ...(sleep ? { sleep } : {}),
  });

  log(`SSH ready on ${peer.ipv4}; querying GPU...`, stderr);
  const gpu = queryRemoteGpu({
    ip: peer.ipv4,
    homeDir,
    runSsh,
  });
  const { rateKey, cuPerHour } = resolveGpuRate(gpu.name, homeDir);
  const createdAt = nowIso();

  const session = writeSession(
    {
      name: peer.hostName,
      account: account.label,
      hostname: peer.hostName,
      ip: peer.ipv4,
      gpu,
      rateKey,
      cuPerHour,
      createdAt,
      lastActivityAt: createdAt,
      activePids: [],
      keep: Boolean(opts.keep),
      state: "active",
      remoteRoot: null,
      forwards: [],
    },
    homeDir,
  );

  if (onSessionStart) {
    await onSessionStart(session, homeDir);
  }

  log(
    `Session ${session.name} ready (${session.gpu.name}, ~${session.cuPerHour} CU/h).`,
    stderr,
  );

  if (json) {
    writeJson(
      {
        ...session,
        estimatedCuPerHour: session.cuPerHour,
      },
      stdout,
    );
  }

  return EXIT_OK;
}
