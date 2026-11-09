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
  log(
    `${formatMark(c.tailscale.ok)} tailscale: ${c.tailscale.backendState}${c.tailscale.selfHostName ? ` (${c.tailscale.selfHostName}${c.tailscale.selfIp ? ` @ ${c.tailscale.selfIp}` : ""})` : ""}`,
    stderr,
  );
  log(`${formatMark(c.ssh.ok)} ssh: ${c.ssh.binaryPath ?? "missing"}`, stderr);
  log(
    `${formatMark(c.sshKeygen.ok)} ssh-keygen: ${c.sshKeygen.binaryPath ?? "missing"}`,
    stderr,
  );
  log(
    `${formatMark(c.rsync.ok, true)} rsync (optional): ${c.rsync.binaryPath ?? "missing (will use tar | ssh)"}`,
    stderr,
  );
  log(`${formatMark(c.git.ok)} git: ${c.git.binaryPath ?? "missing"}`, stderr);
  log(
    `${formatMark(c.clipboard.ok, true)} clipboard (optional): ${c.clipboard.tool ?? "missing"}`,
    stderr,
  );
  log(
    `${formatMark(c.config.ok)} config: authKey=${c.config.hasAuthKey ? "present" : "missing"}, sshKey=${c.config.sshKeyPresent ? "present" : "missing"}${c.config.authKeyAgeDays !== null ? `, age=${c.config.authKeyAgeDays}d` : ""}`,
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
