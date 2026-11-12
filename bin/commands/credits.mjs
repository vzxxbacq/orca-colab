import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_OK,
  log,
  writeJson,
} from "../lib/cli-output.mjs";
import { getConsumptionUserInfo } from "../lib/colab-api-client.mjs";
import { locateOrcaBinary } from "../lib/orca-binary.mjs";
import { readConfig } from "../lib/colab-home.mjs";
import { getValidAccessToken } from "../lib/colab-oauth.mjs";
import {
  projectAccountCredits,
  readLedgerEvents,
  recordBudgetSetEvent,
  recordCalibrateEvent,
  recordSessionEndEvent,
  resolveDeadSessionEndIso,
} from "../lib/credit-ledger.mjs";
import { setRateOverride } from "../lib/rate-table.mjs";
import { deleteSession, listSessions, writeSession } from "../lib/session-store.mjs";

function calibrateViaOrcaEmbeddedBrowser({ env = process.env } = {}) {
  const orcaBin = locateOrcaBinary(env);
  if (!orcaBin) {
    throw new Error("Orca CLI not found for --browser calibration.");
  }
  const createRes = spawnSync(
    orcaBin,
    ["tab", "create", "--url", "https://colab.research.google.com/", "--json"],
    { encoding: "utf8", env, timeout: 15_000 },
  );
  if (createRes.status !== 0) {
    throw new Error(
      `Failed to open Colab in Orca browser: ${(createRes.stderr || createRes.stdout || "").trim()}`,
    );
  }
  const tabInfo = JSON.parse(createRes.stdout.trim());
  const pageId = tabInfo.browserPageId || tabInfo.id;
  if (!pageId) {
    throw new Error("orca tab create --json did not return browserPageId.");
  }

  const expr = `
    (async () => {
      try {
        const text = document.body ? document.body.innerText : "";
        const m = text.match(/([0-9]+(?:\\.[0-9]+)?)\\s*(?:compute units|计算单元)/i);
        if (m) return { balanceCu: Number(m[1]), method: "dom-text" };
      } catch {}
      return null;
    })()
  `.trim();

  const evalRes = spawnSync(
    orcaBin,
    [
      "eval",
      "--page",
      String(pageId),
      "--expect-url",
      "https://colab.research.google.com",
      "--expression",
      expr,
      "--json",
    ],
    { encoding: "utf8", env, timeout: 15_000 },
  );
  if (evalRes.status !== 0) {
    throw new Error("Could not read compute units from Orca browser tab.");
  }
  const parsed = JSON.parse(evalRes.stdout.trim());
  const val = parsed?.result ?? parsed?.value ?? parsed;
  if (val && typeof val.balanceCu === "number" && Number.isFinite(val.balanceCu)) {
    return val.balanceCu;
  }
  throw new Error(
    "Compute units not visible in Colab tab. Sign in with 'orca-colab auth login' or run 'orca-colab credits set <cu>'.",
  );
}

export async function syncCreditsFromColabApi({
  account = "default",
  homeDir,
  fetchImpl = fetch,
  nowMs = () => Date.now(),
  nowIso = () => new Date().toISOString(),
  forceRecord = false,
} = {}) {
  const accessToken = await getValidAccessToken({ account, homeDir, fetchImpl });
  if (!accessToken) {
    return null;
  }
  const ccu = await getConsumptionUserInfo({ accessToken, fetchImpl });
  const balanceCu =
    typeof ccu.paidComputeUnitsBalance === "number"
      ? ccu.paidComputeUnitsBalance
      : 0;
  const accountActive = listSessions(homeDir).filter(
    (s) => (s?.account || "default") === account && s?.state !== "zombie",
  );
  if (ccu.assignmentsCount === 0) {
    for (const s of accountActive) {
      if (s.colabRuntime?.id) {
        deleteSession(s.name, homeDir);
        recordSessionEndEvent(s, {
          cause: "colab-died",
          endedAt: resolveDeadSessionEndIso(s, nowMs()),
          homeDir,
        });
      }
    }
  } else if (
    typeof ccu.consumptionRateHourly === "number" &&
    Number.isFinite(ccu.consumptionRateHourly) &&
    ccu.consumptionRateHourly > 0
  ) {
    const liveRate =
      Math.round((ccu.consumptionRateHourly + Number.EPSILON) * 100) / 100;
    if (accountActive.length === 1) {
      const s = accountActive[0];
      if (s.cuPerHour !== liveRate) {
        writeSession({ ...s, cuPerHour: liveRate }, homeDir);
      }
      if (s.rateKey && s.rateKey !== "unknown") {
        setRateOverride(s.rateKey, liveRate, homeDir);
      }
    }
  }

  const at = nowIso();
  const existingEvents = readLedgerEvents(homeDir);
  const lastCal = [...existingEvents]
    .reverse()
    .find((e) => e?.type === "calibrate" && (e?.account ?? "default") === account);
  const changed =
    forceRecord ||
    !lastCal ||
    lastCal.source !== "colab-api" ||
    Math.abs(Number(lastCal.balanceCu) - balanceCu) > 1e-6 ||
    lastCal.consumptionRateHourly !== ccu.consumptionRateHourly ||
    lastCal.assignmentsCount !== ccu.assignmentsCount;

  const event = {
    type: "calibrate",
    at,
    account,
    balanceCu,
    ...(typeof ccu.consumptionRateHourly === "number" &&
    Number.isFinite(ccu.consumptionRateHourly)
      ? { consumptionRateHourly: ccu.consumptionRateHourly }
      : {}),
    ...(typeof ccu.assignmentsCount === "number" &&
    Number.isFinite(ccu.assignmentsCount)
      ? { assignmentsCount: ccu.assignmentsCount }
      : {}),
    source: "colab-api",
  };

  if (changed) {
    recordCalibrateEvent(
      {
        account,
        balanceCu,
        consumptionRateHourly: ccu.consumptionRateHourly,
        assignmentsCount: ccu.assignmentsCount,
        source: "colab-api",
        at,
      },
      homeDir,
    );
  }

  return {
    event,
    balanceCu,
    subscriptionTier: ccu.subscriptionTier || null,
    consumptionRateHourly: ccu.consumptionRateHourly,
    assignmentsCount: ccu.assignmentsCount,
  };
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
    nowMs = () => Date.now(),
    nowIso = () => new Date().toISOString(),
  },
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        account: { type: "string" },
        browser: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const config = readConfig(homeDir);
  const account =
    parsed.values.account?.trim() || config?.defaultAccount || "default";
  const [subcommand, rawValue] = parsed.positionals;

  let liveEvent = null;

  if (subcommand === "set") {
    const balanceCu = Number(rawValue);
    if (rawValue === undefined || !Number.isFinite(balanceCu) || balanceCu < 0) {
      throw new CliError("usage: orca-colab credits set <cu> [--account A]");
    }
    recordCalibrateEvent(
      { account, balanceCu, source: "manual", at: nowIso() },
      homeDir,
    );
  } else if (subcommand === "budget") {
    const budgetCu = Number(rawValue);
    if (rawValue === undefined || !Number.isFinite(budgetCu) || budgetCu < 0) {
      throw new CliError("usage: orca-colab credits budget <cu> [--account A]");
    }
    recordBudgetSetEvent({ account, budgetCu, at: nowIso() }, homeDir);
  } else if (subcommand === "calibrate") {
    let calibrated = false;
    if (!parsed.values.browser) {
      try {
        const synced = await syncCreditsFromColabApi({
          account,
          homeDir,
          fetchImpl,
          nowMs,
          nowIso,
          forceRecord: true,
        });
        if (synced) {
          liveEvent = synced.event;
          log(
            `Calibrated account '${account}' via Colab API: ${synced.balanceCu} CU${synced.subscriptionTier ? ` (${synced.subscriptionTier})` : ""}.`,
            stderr,
          );
          calibrated = true;
        }
      } catch (err) {
        log(
          `Colab API calibration failed (${err instanceof Error ? err.message : String(err)}); trying fallback...`,
          stderr,
        );
      }
    }

    if (!calibrated) {
      try {
        const balanceCu = calibrateViaOrcaEmbeddedBrowser({ env });
        recordCalibrateEvent(
          { account, balanceCu, source: "browser", at: nowIso() },
          homeDir,
        );
        log(`Calibrated account '${account}' via Orca browser: ${balanceCu} CU.`, stderr);
      } catch (err) {
        throw new CliError(
          `Automatic calibration unavailable (${err instanceof Error ? err.message : String(err)}). Sign in with 'orca-colab auth login' (tick the Colab permission), or enter the balance with 'orca-colab credits set <cu>'.`,
        );
      }
    }
  } else if (subcommand === undefined) {
    if (!parsed.values.browser) {
      try {
        const synced = await syncCreditsFromColabApi({
          account,
          homeDir,
          fetchImpl,
          nowMs,
          nowIso,
          forceRecord: false,
        });
        if (synced) {
          liveEvent = synced.event;
        }
      } catch {
        // Offline or token unavailable; use ledger state.
      }
    }
  } else {
    throw new CliError(
      `unknown credits subcommand '${subcommand}' (expected 'set', 'budget', or 'calibrate')`,
    );
  }

  const events = readLedgerEvents(homeDir);
  if (liveEvent && events.at(-1)?.at !== liveEvent.at) {
    events.push(liveEvent);
  }
  const activeSessions = listSessions(homeDir);
  const projection = projectAccountCredits({
    events,
    activeSessions,
    account,
    nowMs: nowMs(),
  });

  if (json) {
    writeJson(projection, stdout);
    return EXIT_OK;
  }

  const balText =
    projection.estimatedBalanceCu !== null
      ? `≈ ${projection.estimatedBalanceCu} CU (calibrated ${projection.calibrationAgeSeconds ?? 0}s ago)`
      : "uncalibrated (run 'orca-colab credits set <cu>' or 'orca-colab credits calibrate')";
  log(
    `Account '${projection.account}' (approximate): balance ${balText}, burn ≈ ${projection.estimatedBurnCuPerHour} CU/h, month used ≈ ${projection.estimatedMonthlyUsedCu} CU${projection.budgetCu !== null ? ` / budget ${projection.budgetCu} CU` : ""}`,
    stderr,
  );
  return EXIT_OK;
}
