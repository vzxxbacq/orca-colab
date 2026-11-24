import { parseArgs } from "node:util";
import { CliError, EXIT_ERROR, EXIT_OK, log, writeJson } from "../lib/cli-output.mjs";
import { runDoctor } from "../lib/doctor.mjs";
import { checkNetwork } from "../lib/network-check.mjs";

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
  const report = runDoctor({ homeDir, env, cwd: projectDir });
  if (network) {
    // The only part of doctor that touches the network: one request per endpoint, no credentials sent.
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
    `${formatMark(c.oauth.ok)} google sign-in: ${c.oauth.ok ? c.oauth.email || c.oauth.account : "not signed in"}`,
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
