import os from "node:os";
import { parseArgs } from "node:util";
import {
  CliError,
  EXIT_ERROR,
  EXIT_OK,
  log,
  logError,
  writeJson,
} from "../lib/cli-output.mjs";
import { getConsumptionUserInfo, listRuntimes } from "../lib/colab-api-client.mjs";
import { readConfig, resolveAccount } from "../lib/colab-home.mjs";
import {
  getValidAccessToken,
  readOAuthAccountStatus,
  removeOAuthCredentials,
  runLoopbackOAuthFlow,
} from "../lib/colab-oauth.mjs";
import { recordCalibrateEvent } from "../lib/credit-ledger.mjs";

export async function run(
  argv,
  {
    json = false,
    stdout = process.stdout,
    stderr = process.stderr,
    homeDir = os.homedir(),
    fetchImpl = fetch,
    openBrowser,
    signal,
    nowIso = () => new Date().toISOString(),
  } = {},
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        account: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const config = readConfig(homeDir);
  const accountObj = resolveAccount(config, parsed.values.account);
  const account = accountObj.label;
  const sub = parsed.positionals[0] || "status";

  if (sub === "login") {
    log(
      `Opening Google sign-in in your default browser for account '${account}' (Passkey supported)...`,
      stderr,
    );
    try {
      const status = await runLoopbackOAuthFlow({
        account,
        homeDir,
        ...(openBrowser ? { openBrowser } : {}),
        fetchImpl,
        signal,
        onAuthUrl: (url) => {
          log(`If the browser did not open, visit: ${url}`, stderr);
        },
      });

      let ccuInfo = null;
      try {
        const accessToken = await getValidAccessToken({ account, homeDir, fetchImpl });
        if (accessToken) {
          ccuInfo = await getConsumptionUserInfo({ accessToken, fetchImpl, signal });
          if (typeof ccuInfo.paidComputeUnitsBalance === "number") {
            recordCalibrateEvent(
              {
                account,
                balanceCu: ccuInfo.paidComputeUnitsBalance,
                source: "colab-api",
                at: nowIso(),
              },
              homeDir,
            );
          }
        }
      } catch {
        // Non-fatal if user-info endpoint is unreachable right after login.
      }

      const payload = {
        ok: true,
        ...status,
        subscriptionTier: ccuInfo?.subscriptionTier || null,
        estimatedBalanceCu:
          typeof ccuInfo?.paidComputeUnitsBalance === "number"
            ? Number(ccuInfo.paidComputeUnitsBalance.toFixed(2))
            : null,
        consumptionRateHourly: ccuInfo?.consumptionRateHourly ?? null,
      };

      if (json) {
        writeJson(payload, stdout);
      } else {
        log(
          `Signed in to Google Colab (${payload.email || payload.account})${
            payload.subscriptionTier ? ` [${payload.subscriptionTier}]` : ""
          }${
            payload.estimatedBalanceCu !== null
              ? ` · balance ≈ ${payload.estimatedBalanceCu} CU`
              : ""
          }`,
          stderr,
        );
      }
      return EXIT_OK;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Google OAuth sign-in failed: ${msg}`, stderr);
      if (json) {
        writeJson({ ok: false, account, authenticated: false, error: msg }, stdout);
      }
      return EXIT_ERROR;
    }
  }

  if (sub === "logout") {
    const removed = removeOAuthCredentials(account, homeDir);
    const payload = {
      ok: true,
      account,
      authenticated: false,
      removed,
    };
    if (json) {
      writeJson(payload, stdout);
    } else {
      log(
        removed
          ? `Signed out Google Colab OAuth credentials for account '${account}'.`
          : `No Google Colab OAuth credentials stored for account '${account}'.`,
        stderr,
      );
    }
    return EXIT_OK;
  }

  if (sub === "status") {
    const base = readOAuthAccountStatus(account, homeDir);
    if (!base.authenticated) {
      const payload = { ok: true, ...base, assignedRuntimesCount: 0 };
      if (json) {
        writeJson(payload, stdout);
      } else {
        log(
          `Account '${account}': not signed in with Google OAuth (run 'orca-colab auth login').`,
          stderr,
        );
      }
      return EXIT_OK;
    }

    let ccuInfo = null;
    let activeRuntimes = [];
    try {
      const accessToken = await getValidAccessToken({ account, homeDir, fetchImpl });
      if (accessToken) {
        [ccuInfo, activeRuntimes] = await Promise.all([
          getConsumptionUserInfo({ accessToken, fetchImpl, signal }).catch(() => null),
          listRuntimes({ accessToken, fetchImpl, signal }).catch(() => []),
        ]);
      }
    } catch {
      // Best-effort status enrichment.
    }

    const payload = {
      ok: true,
      ...base,
      subscriptionTier: ccuInfo?.subscriptionTier || null,
      estimatedBalanceCu:
        typeof ccuInfo?.paidComputeUnitsBalance === "number"
          ? Number(ccuInfo.paidComputeUnitsBalance.toFixed(2))
          : null,
      consumptionRateHourly: ccuInfo?.consumptionRateHourly ?? null,
      assignedRuntimesCount: activeRuntimes.length,
    };

    if (json) {
      writeJson(payload, stdout);
    } else {
      log(
        `Account '${payload.account}': signed in${payload.email ? ` as ${payload.email}` : ""}${
          payload.subscriptionTier ? ` (${payload.subscriptionTier})` : ""
        }${
          payload.estimatedBalanceCu !== null
            ? ` · balance ≈ ${payload.estimatedBalanceCu} CU`
            : ""
        } · ${payload.assignedRuntimesCount} assigned runtime(s)`,
        stderr,
      );
    }
    return EXIT_OK;
  }

  throw new CliError(
    `unknown auth subcommand '${sub}' (expected 'login', 'status', or 'logout')`,
  );
}
