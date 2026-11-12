import { EXIT_ERROR, EXIT_OK, log, writeJson } from "../lib/cli-output.mjs";
import { runDoctor } from "../lib/doctor.mjs";

function formatMark(ok, optional = false) {
  if (ok) return "✓";
  return optional ? "!" : "✗";
}

export async function run(_argv, { json, stdout, stderr, env, homeDir }) {
  const report = runDoctor({ homeDir, env });
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

  for (const warning of report.warnings) {
    log(`warning: ${warning}`, stderr);
  }
  for (const action of report.actions) {
    log(`action: ${action}`, stderr);
  }

  return report.ok ? EXIT_OK : EXIT_ERROR;
}
