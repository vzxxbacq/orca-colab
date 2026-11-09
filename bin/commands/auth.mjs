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
import {
  listKnownAccountLabels,
  readConfig,
  resolveAccount,
  setDefaultAccount,
} from "../lib/colab-home.mjs";
import {
  getValidAccessToken,
  listOAuthAccounts,
  readOAuthAccountStatus,
  removeOAuthCredentials,
  resolveOAuthAccountKey,
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
        add: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const config = readConfig(homeDir);
  const sub = parsed.positionals[0] || "status";
  const positionalTarget = parsed.positionals[1] || null;
  const requestedAccount = parsed.values.account || positionalTarget || undefined;
  const accountObj = resolveAccount(config, requestedAccount);
  const account = accountObj.label;

  if (sub === "login" || sub === "add") {
    const addAccount = Boolean(parsed.values.add || sub === "add");
    log(
      addAccount
        ? `Opening Google sign-in in your default browser to add an account (Passkey supported)...`
        : `Opening Google sign-in in your default browser for account '${account}' (Passkey supported)...`,
      stderr,
    );
    try {
      const status = await runLoopbackOAuthFlow({
        account: addAccount && !requestedAccount ? "auto" : account,
        addAccount,
        homeDir,
        ...(openBrowser ? { openBrowser } : {}),
        fetchImpl,
        signal,
        onAuthUrl: (url) => {
          log(`If the browser did not open, visit: ${url}`, stderr);
        },
      });
      const savedAccount = status.account || account;
      setDefaultAccount(savedAccount, homeDir);

      let ccuInfo = null;
      try {
        const accessToken = await getValidAccessToken({
          account: savedAccount,
          homeDir,
          fetchImpl,
        });
        if (accessToken) {
          ccuInfo = await getConsumptionUserInfo({ accessToken, fetchImpl, signal });
          if (typeof ccuInfo.paidComputeUnitsBalance === "number") {
            recordCalibrateEvent(
              {
                account: savedAccount,
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
        defaultAccount: savedAccount,
        accounts: listOAuthAccounts(homeDir),
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

  if (sub === "switch" || sub === "default") {
    if (!requestedAccount) {
      throw new CliError("Usage: orca-colab auth switch <account>");
    }
    const targetKey = resolveOAuthAccountKey(requestedAccount, null, homeDir);
    const updatedCfg = setDefaultAccount(targetKey, homeDir);
    const status = readOAuthAccountStatus(targetKey, homeDir);
    const payload = {
      ok: true,
      defaultAccount: updatedCfg.defaultAccount,
      account: status.account,
      email: status.email,
      authenticated: status.authenticated,
      accounts: listOAuthAccounts(homeDir),
    };
    if (json) {
      writeJson(payload, stdout);
    } else {
      log(
        `Default Google Colab account switched to '${payload.defaultAccount}'${
          payload.email ? ` (${payload.email})` : ""
        }.`,
        stderr,
      );
    }
    return EXIT_OK;
  }

  if (sub === "logout") {
    if (parsed.values.all) {
      const all = listOAuthAccounts(homeDir);
      for (const acc of all) {
        removeOAuthCredentials(acc.account, homeDir);
      }
      const payload = {
        ok: true,
        removedCount: all.length,
        authenticated: false,
        accounts: [],
      };
      if (json) {
        writeJson(payload, stdout);
      } else {
        log(`Signed out all (${all.length}) Google Colab OAuth account(s).`, stderr);
      }
      return EXIT_OK;
    }

    const targetKey = resolveOAuthAccountKey(account, null, homeDir);
    const removed = removeOAuthCredentials(targetKey, homeDir);
    const remaining = listOAuthAccounts(homeDir);
    if (removed && config?.defaultAccount === targetKey && remaining.length > 0) {
      setDefaultAccount(remaining[0].account, homeDir);
    }
    const payload = {
      ok: true,
      account: targetKey,
      authenticated: false,
      removed,
      accounts: remaining,
    };
    if (json) {
      writeJson(payload, stdout);
    } else {
      log(
        removed
          ? `Signed out Google Colab OAuth credentials for account '${targetKey}'.`
          : `No Google Colab OAuth credentials stored for account '${targetKey}'.`,
        stderr,
      );
    }
    return EXIT_OK;
  }

  if (sub === "list") {
    const allAccounts = listOAuthAccounts(homeDir);
    const currentDefault = resolveAccount(readConfig(homeDir)).label;
    const enriched = await Promise.all(
      allAccounts.map(async (acc) => {
        let ccuInfo = null;
        let activeRuntimes = [];
        try {
          const accessToken = await getValidAccessToken({
            account: acc.account,
            homeDir,
            fetchImpl,
          });
          if (accessToken) {
            [ccuInfo, activeRuntimes] = await Promise.all([
              getConsumptionUserInfo({ accessToken, fetchImpl, signal }).catch(
                () => null,
              ),
              listRuntimes({ accessToken, fetchImpl, signal }).catch(() => []),
            ]);
          }
        } catch {
          // Best-effort status enrichment.
        }
        return {
          ...acc,
          isDefault: acc.account === currentDefault,
          subscriptionTier: ccuInfo?.subscriptionTier || null,
          estimatedBalanceCu:
            typeof ccuInfo?.paidComputeUnitsBalance === "number"
              ? Number(ccuInfo.paidComputeUnitsBalance.toFixed(2))
              : null,
          assignedRuntimesCount: activeRuntimes.length,
        };
      }),
    );

    const payload = {
      ok: true,
      defaultAccount: currentDefault,
      accounts: enriched,
    };
    if (json) {
      writeJson(payload, stdout);
    } else if (enriched.length === 0) {
      log("No Google Colab accounts signed in (run 'orca-colab auth login').", stderr);
    } else {
      for (const a of enriched) {
        log(
          `${a.isDefault ? "* " : "  "}${a.account}${a.email && a.email !== a.account ? ` (${a.email})` : ""}${
            a.estimatedBalanceCu !== null ? ` · ≈${a.estimatedBalanceCu} CU` : ""
          } · ${a.assignedRuntimesCount} runtime(s)`,
          stderr,
        );
      }
    }
    return EXIT_OK;
  }

  if (sub === "status") {
    const allOAuth = listOAuthAccounts(homeDir);
    const targetAccount =
      !requestedAccount &&
      !readOAuthAccountStatus(account, homeDir).authenticated &&
      allOAuth.length > 0
        ? allOAuth[0].account
        : account;
    const base = readOAuthAccountStatus(targetAccount, homeDir);
    if (!base.authenticated) {
      const payload = {
        ok: true,
        ...base,
        defaultAccount: account,
        accounts: allOAuth,
        assignedRuntimesCount: 0,
      };
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
      const accessToken = await getValidAccessToken({
        account: base.account,
        homeDir,
        fetchImpl,
      });
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
      defaultAccount: account,
      accounts: allOAuth,
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
        } · ${payload.assignedRuntimesCount} assigned runtime(s)${
          allOAuth.length > 1 ? ` · ${allOAuth.length} accounts connected` : ""
        }`,
        stderr,
      );
    }
    return EXIT_OK;
  }

  throw new CliError(
    `unknown auth subcommand '${sub}' (expected 'login', 'add', 'list', 'switch', 'status', or 'logout')`,
  );
}
