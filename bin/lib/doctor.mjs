import os from "node:os";
import { readConfig, resolveAccount, resolveAgentPolicy } from "./colab-home.mjs";
import { listOAuthAccounts, readOAuthAccountStatus } from "./colab-oauth.mjs";
import { findExecutableOnPath } from "./executable-lookup.mjs";

export function runDoctor({
  homeDir = os.homedir(),
  env = process.env,
  platform = process.platform,
  nodeVersion = process.versions.node,
  findBinary = findExecutableOnPath,
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
  const policy = resolveAgentPolicy(config);
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

  const ok = nodeCheck.ok && gitCheck.ok && tarCheck.ok && oauthOk;

  return {
    ok,
    mode: oauthOk ? "direct-api" : "unconfigured",
    policy,
    checks: {
      node: nodeCheck,
      oauth: oauthCheck,
      git: gitCheck,
      tar: tarCheck,
    },
    actions,
    warnings,
  };
}
