import os from "node:os";
import { readConfig, resolveAccount, resolveAgentPolicy } from "./colab-home.mjs";
import { resolveGuardrails } from "./project-guardrails.mjs";
import { listOAuthAccounts, readOAuthAccountStatus } from "./colab-oauth.mjs";
import { findExecutableOnPath } from "./executable-lookup.mjs";
import { describeProxyPlan, resolveProxyPlan } from "./network-proxy.mjs";

export function runDoctor({
  homeDir = os.homedir(),
  env = process.env,
  cwd = null,
  platform = process.platform,
  nodeVersion = process.versions.node,
  findBinary = findExecutableOnPath,
  proxyPlan = null,
} = {}) {
  const actions = [];
  const warnings = [];

  const majorNode = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  const nodeOk = Number.isFinite(majorNode) && majorNode >= 20;
  const nodeCheck = {
    ok: nodeOk,
    version: String(nodeVersion),
    required: ">=20",
  };
  if (!nodeOk) {
    nodeCheck.action = "Install Node.js 20 or newer (https://nodejs.org/).";
    actions.push(nodeCheck.action);
  }

  const gitPath = findBinary("git", { env, platform });
  const gitCheck = {
    ok: Boolean(gitPath),
    binaryPath: gitPath,
  };
  if (!gitPath) {
    gitCheck.action = "Install 'git' so it is available on your PATH.";
    actions.push(gitCheck.action);
  }

  // sync and pull pack files with the local tar (bsdtar ships with Windows 10+ and macOS).
  const tarPath = findBinary("tar", { env, platform });
  const tarCheck = {
    ok: Boolean(tarPath),
    binaryPath: tarPath,
  };
  if (!tarPath) {
    tarCheck.action = "Install 'tar' so 'orca-colab sync' and 'pull' can pack files.";
    actions.push(tarCheck.action);
  }

  const config = readConfig(homeDir);
  // What `up` started from `cwd` would be held to: the project's .orca/colab.json over this machine's
  // config. A project file that cannot be read fails the check, as it fails `up`.
  let policy;
  let guardrailsCheck = null;
  try {
    const { setByProject: _fields, ...guardrails } = resolveGuardrails({ cwd, homeDir });
    policy = guardrails;
    if (guardrails.source === "project") {
      guardrailsCheck = { ok: true, file: guardrails.file };
    }
  } catch (err) {
    policy = { ...resolveAgentPolicy(config), monthlyBudgetCu: null, autoStopIdleMinutes: null, source: "machine", project: null, file: null };
    guardrailsCheck = { ok: false, file: err?.payload?.file ?? null, action: err instanceof Error ? err.message : String(err) };
    actions.push(guardrailsCheck.action);
  }
  const defaultAcc = config ? resolveAccount(config) : null;
  const allOAuthAccounts = listOAuthAccounts(homeDir);
  const primaryOAuthStatus = readOAuthAccountStatus(
    defaultAcc?.label || "default",
    homeDir,
  );
  const oauthStatus = primaryOAuthStatus?.authenticated
    ? primaryOAuthStatus
    : allOAuthAccounts[0] || primaryOAuthStatus;
  const oauthOk = Boolean(oauthStatus?.authenticated);
  const oauthCheck = {
    ok: oauthOk,
    account: oauthStatus?.account || defaultAcc?.label || "default",
    email: oauthStatus?.email || null,
    accountsCount: allOAuthAccounts.length,
    accounts: allOAuthAccounts.map((a) => ({
      account: a.account,
      email: a.email,
    })),
  };
  if (!oauthOk) {
    oauthCheck.action = primaryOAuthStatus?.reauthRequired
      ? "Sign in again with 'orca-colab auth login' (orca-colab now uses its own Google OAuth client)."
      : "Sign in with 'orca-colab auth login' and tick the Colab permission on Google's consent page.";
    actions.push(oauthCheck.action);
  }

  // Which proxy requests go through; `doctor --network` adds whether each endpoint answers.
  const { warning: proxyWarning, ...proxy } = describeProxyPlan(proxyPlan ?? resolveProxyPlan({ env, homeDir, platform }));
  const proxyCheck = { ok: !proxyWarning, ...proxy };
  if (proxyWarning) {
    warnings.push(proxyWarning);
  }

  const ok = nodeCheck.ok && gitCheck.ok && tarCheck.ok && oauthOk && guardrailsCheck?.ok !== false;

  return {
    ok,
    mode: oauthOk ? "direct-api" : "unconfigured",
    policy,
    checks: {
      node: nodeCheck,
      oauth: oauthCheck,
      git: gitCheck,
      tar: tarCheck,
      proxy: proxyCheck,
      ...(guardrailsCheck ? { guardrails: guardrailsCheck } : {}),
    },
    actions,
    warnings,
  };
}
