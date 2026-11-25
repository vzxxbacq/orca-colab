import os from "node:os";
import { readConfig, resolveAccount, resolveAgentPolicy } from "./colab-home.mjs";
import { resolveGuardrails } from "./project-guardrails.mjs";
import { listOAuthAccounts, listReauthAccounts, readOAuthAccountStatus } from "./colab-oauth.mjs";
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
  const reauthAccounts = listReauthAccounts(homeDir);
  const signInAgain = (a) =>
    a.reauthError === "client_changed"
      ? "Sign in again with 'orca-colab auth login' (orca-colab now uses its own Google OAuth client)."
      : `${a.reauthReason}${a.email ? ` for ${a.email}` : ""}. Sign in again with 'orca-colab auth login' (tick the Colab permission); no sign-out is needed.`;
  const oauthCheck = {
    ok: oauthOk,
    account: oauthStatus?.account || defaultAcc?.label || "default",
    email: oauthStatus?.email || null,
    accountsCount: allOAuthAccounts.length,
    accounts: allOAuthAccounts.map((a) => ({
      account: a.account,
      email: a.email,
    })),
    reauthRequired: !oauthOk && reauthAccounts.length > 0,
    reauthAccounts: reauthAccounts.map((a) => ({
      account: a.account,
      email: a.email,
      reauthError: a.reauthError,
      reauthReason: a.reauthReason,
      reauthAt: a.reauthAt,
    })),
  };
  if (!oauthOk) {
    const refused = primaryOAuthStatus?.reauthRequired ? primaryOAuthStatus : reauthAccounts[0];
    if (refused) {
      oauthCheck.reauthReason = refused.reauthReason;
    }
    oauthCheck.action = refused
      ? signInAgain(refused)
      : "Sign in with 'orca-colab auth login' and tick the Colab permission on Google's consent page.";
    actions.push(oauthCheck.action);
  } else {
    // Another account still works, so nothing is blocked; the dead one is still worth a line.
    for (const a of reauthAccounts) {
      warnings.push(`Account '${a.account}': ${signInAgain(a)}`);
    }
    if (oauthStatus.refreshTokenExpiresAt) {
      warnings.push(
        `Google will end the sign-in of ${oauthStatus.email || oauthStatus.account} on ${oauthStatus.refreshTokenExpiresAt}: this OAuth client issues refresh tokens with a fixed lifetime (its consent screen is in "Testing").`,
      );
    }
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
