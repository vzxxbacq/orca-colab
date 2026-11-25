import { parseArgs } from "node:util";
import { CliError, EXIT_ERROR, EXIT_OK, log, writeJson } from "../lib/cli-output.mjs";
import { runDoctor } from "../lib/doctor.mjs";
import { checkNetwork } from "../lib/network-check.mjs";
import { getValidAccessToken, listStoredOAuthAccounts, OAUTH_REAUTH_REQUIRED } from "../lib/colab-oauth.mjs";

// Asks Google whether each saved sign-in still works, with a real refresh: the file alone cannot tell.
// A refusal is recorded by the refresh itself, so the report built afterwards shows it.
async function verifySignIns({ homeDir, fetchImpl }) {
  const results = [];
  for (const acc of listStoredOAuthAccounts(homeDir)) {
    if (acc.reauthError === "client_changed") continue;
    try {
      await getValidAccessToken({ account: acc.account, homeDir, fetchImpl, recheck: true, forceRefresh: true });
      results.push({ account: acc.account, email: acc.email, ok: true, result: "accepted", error: null });
    } catch (err) {
      results.push({
        account: acc.account,
        email: acc.email,
        ok: false,
        result:
          err?.code === OAUTH_REAUTH_REQUIRED ? "refused" : err?.code === "NETWORK_UNREACHABLE" ? "unreachable" : "failed",
        error: err?.message || String(err),
      });
    }
  }
  return results;
}

function formatMark(ok, optional = false) {
  if (ok) return "✓";
  return optional ? "!" : "✗";
}

export async function run(argv, { json, stdout, stderr, env, homeDir, cwd = null, projectDir = cwd, fetchImpl = fetch }) {
  let network;
  try {
    network = parseArgs({ args: argv, options: { network: { type: "boolean", default: false } }, strict: true }).values.network;
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  // The only part of doctor that touches the network: one token refresh per saved sign-in, then one
  // request per endpoint without credentials.
  const signIns = network ? await verifySignIns({ homeDir, fetchImpl }) : null;
  const report = runDoctor({ homeDir, env, cwd: projectDir });
  if (network) {
    report.checks.oauth.refresh = signIns;
    for (const failed of signIns.filter((r) => r.result === "failed")) {
      report.warnings.push(`Could not confirm the Google sign-in of ${failed.email || failed.account}: ${failed.error}`);
    }
    const { proxy: _plan, ...checked } = await checkNetwork({ homeDir, fetchImpl });
    report.checks.network = checked;
    if (!checked.ok) {
      report.ok = false;
      report.actions.push(checked.action);
    }
  }
  if (json) {
    writeJson(report, stdout);
    return report.ok ? EXIT_OK : EXIT_ERROR;
  }

  const c = report.checks;
  log(
    `${formatMark(c.node.ok)} node ${c.node.version} (required ${c.node.required})`,
    stderr,
  );
  log(`${formatMark(c.git.ok)} git: ${c.git.binaryPath ?? "missing"}`, stderr);
  log(`${formatMark(c.tar.ok)} tar: ${c.tar.binaryPath ?? "missing"}`, stderr);
  log(
    `${formatMark(c.oauth.ok)} google sign-in: ${
      c.oauth.ok
        ? `${c.oauth.email || c.oauth.account}${c.oauth.refresh?.some((r) => r.account === c.oauth.account && r.ok) ? " (Google accepted a token refresh)" : ""}`
        : c.oauth.reauthRequired
          ? `sign in again: ${c.oauth.reauthReason}`
          : "not signed in"
    }`,
    stderr,
  );
  log(
    c.proxy.url
      ? `${formatMark(c.proxy.ok, true)} proxy: ${c.proxy.url} (${c.proxy.source})`
      : `${formatMark(c.proxy.ok, true)} proxy: none${c.proxy.mode === "off" ? " (off)" : " (auto: no HTTPS_PROXY / ALL_PROXY and no system proxy)"}`,
    stderr,
  );
  if (c.network) {
    for (const e of c.network.endpoints) {
      log(
        `${formatMark(e.ok)} ${e.name} ${e.host}: ${e.ok ? `HTTP ${e.status}` : `${e.causeCode} (${e.error})`} · ${e.latencyMs} ms · ${e.proxy ? `via ${e.proxy}` : "direct"}`,
        stderr,
      );
    }
  } else {
    log("network: not checked (run 'orca-colab doctor --network' to reach every endpoint)", stderr);
  }

  log(
    report.policy.source === "project"
      ? `guardrails: ${report.policy.file} (GPUs ${report.policy.allowedGpus.join(", ")}; max ${report.policy.maxConcurrentSessions} at once${report.policy.monthlyBudgetCu ? `; ${report.policy.monthlyBudgetCu} CU/month for this project` : ""})`
      : `guardrails: this machine's config (GPUs ${report.policy.allowedGpus.join(", ")}; max ${report.policy.maxConcurrentSessions} at once)`,
    stderr,
  );

  for (const warning of report.warnings) {
    log(`warning: ${warning}`, stderr);
  }
  for (const action of report.actions) {
    log(`action: ${action}`, stderr);
  }

  return report.ok ? EXIT_OK : EXIT_ERROR;
}
