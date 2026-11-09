import { existsSync } from "node:fs";
import os from "node:os";
import {
  getColabPaths,
  isValidAuthKey,
  readConfig,
  resolveAccount,
  resolveAgentPolicy,
} from "./colab-home.mjs";
import { readOAuthAccountStatus } from "./colab-oauth.mjs";
import {
  findExecutableOnPath,
  getTailscaleStatus,
} from "./tailscale-cli.mjs";

const MS_PER_DAY = 86_400_000;
const AUTH_KEY_WARN_DAYS = 83;
const AUTH_KEY_MAX_DAYS = 90;

export function detectClipboardTool({
  env = process.env,
  platform = process.platform,
  findBinary = findExecutableOnPath,
} = {}) {
  const candidates =
    platform === "darwin"
      ? ["pbcopy"]
      : platform === "win32"
        ? ["clip.exe", "clip"]
        : ["wl-copy", "xclip", "xsel"];

  for (const tool of candidates) {
    const binaryPath = findBinary(tool, { env, platform });
    if (binaryPath) {
      return { tool, binaryPath };
    }
  }
  return { tool: null, binaryPath: null };
}

export function runDoctor({
  homeDir = os.homedir(),
  env = process.env,
  platform = process.platform,
  nodeVersion = process.versions.node,
  now = new Date(),
  findBinary = findExecutableOnPath,
  tailscaleStatus = null,
  runCommand = null,
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

  let ts;
  if (tailscaleStatus) {
    ts = tailscaleStatus;
  } else {
    try {
      ts = getTailscaleStatus({ env, platform, runCommand });
    } catch (err) {
      ts = {
        found: true,
        binaryPath: null,
        backendState: "Error",
        loggedIn: false,
        tailnetName: null,
        self: null,
        peers: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const tailscaleOk = Boolean(ts.found && ts.loggedIn);
  const tailscaleCheck = {
    ok: tailscaleOk,
    binaryPath: ts.binaryPath ?? null,
    backendState: ts.backendState ?? "Unknown",
    loggedIn: Boolean(ts.loggedIn),
    tailnetName: ts.tailnetName ?? null,
    selfHostName: ts.self?.hostName ?? null,
    selfIp: ts.self?.ipv4 ?? null,
    detectedLoginServer: ts.detectedLoginServer ?? null,
  };
  if (!ts.found) {
    tailscaleCheck.action =
      "Install Tailscale (https://tailscale.com/download) and sign in to your tailnet.";
    actions.push(tailscaleCheck.action);
  } else if (!ts.loggedIn) {
    tailscaleCheck.action = `Start and sign in to Tailscale (current state: ${tailscaleCheck.backendState}; run 'tailscale up').`;
    actions.push(tailscaleCheck.action);
  }

  const sshPath = findBinary("ssh", { env, platform });
  const sshCheck = {
    ok: Boolean(sshPath),
    binaryPath: sshPath,
  };
  if (!sshPath) {
    sshCheck.action = "Install OpenSSH client so 'ssh' is on your PATH.";
    actions.push(sshCheck.action);
  }

  const sshKeygenPath = findBinary("ssh-keygen", { env, platform });
  const sshKeygenCheck = {
    ok: Boolean(sshKeygenPath),
    binaryPath: sshKeygenPath,
  };
  if (!sshKeygenPath) {
    sshKeygenCheck.action =
      "Install OpenSSH tools so 'ssh-keygen' is on your PATH.";
    actions.push(sshKeygenCheck.action);
  }

  const rsyncPath = findBinary("rsync", { env, platform });
  const rsyncCheck = {
    ok: Boolean(rsyncPath),
    optional: true,
    binaryPath: rsyncPath,
  };
  if (!rsyncPath) {
    rsyncCheck.action =
      "Install 'rsync' for fast incremental sync (falling back to 'tar | ssh').";
    warnings.push(rsyncCheck.action);
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

  const clip = detectClipboardTool({ env, platform, findBinary });
  const clipboardCheck = {
    ok: Boolean(clip.binaryPath),
    optional: true,
    tool: clip.tool,
    binaryPath: clip.binaryPath,
  };
  if (!clip.binaryPath) {
    clipboardCheck.action =
      "No system clipboard utility found (pbcopy/wl-copy/xclip/clip.exe); values will be printed to the terminal instead.";
    warnings.push(clipboardCheck.action);
  }

  const paths = getColabPaths(homeDir);
  const config = readConfig(homeDir);
  const policy = resolveAgentPolicy(config);
  const configPresent = Boolean(config);
  const effectiveLoginServer =
    config?.loginServer ?? ts.detectedLoginServer ?? null;
  const hasAuthKey = isValidAuthKey(config?.authKey, effectiveLoginServer);
  const sshKeyPresent =
    existsSync(paths.privateKeyPath) && existsSync(paths.publicKeyPath);
  const defaultAcc = config ? resolveAccount(config) : null;
  const notebookUrlConfigured = Boolean(defaultAcc?.notebookUrl);

  const oauthStatus = readOAuthAccountStatus(
    defaultAcc?.label || "default",
    homeDir,
  );
  const oauthOk = Boolean(oauthStatus?.authenticated);
  const oauthCheck = {
    ok: oauthOk,
    account: oauthStatus?.account || defaultAcc?.label || "default",
    email: oauthStatus?.email || null,
  };

  let authKeyAgeDays = null;
  let authKeyExpired = false;
  let configWarning = null;
  if (config?.authKeyCreatedAt) {
    const createdMs = Date.parse(config.authKeyCreatedAt);
    if (!Number.isNaN(createdMs)) {
      const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
      authKeyAgeDays = Math.max(
        0,
        Math.floor((nowMs - createdMs) / MS_PER_DAY),
      );
      if (authKeyAgeDays >= AUTH_KEY_MAX_DAYS) {
        authKeyExpired = true;
      } else if (authKeyAgeDays >= AUTH_KEY_WARN_DAYS) {
        const remaining = AUTH_KEY_MAX_DAYS - authKeyAgeDays;
        configWarning = `Tailscale auth key is ${authKeyAgeDays} days old (${remaining} day(s) until 90-day expiry); rotate it with 'orca-colab setup'.`;
        warnings.push(configWarning);
      }
    }
  }

  const configOk =
    configPresent && hasAuthKey && sshKeyPresent && !authKeyExpired;
  const configCheck = {
    ok: configOk,
    configPresent,
    hasAuthKey,
    sshKeyPresent,
    notebookUrlConfigured,
    authKeyAgeDays,
    loginServer: effectiveLoginServer,
  };
  if (configWarning) {
    configCheck.warning = configWarning;
  }
  if (!configOk) {
    if (authKeyExpired) {
      configCheck.action = `Tailscale auth key is ${authKeyAgeDays} days old (>= 90 days); create a new key and run 'orca-colab setup'.`;
    } else if (!configPresent || !hasAuthKey || !sshKeyPresent) {
      configCheck.action =
        "Run 'orca-colab auth login' (recommended, Tailscale-free Direct API) or 'orca-colab setup' (Tailscale SSH).";
    }
    if (!oauthOk) {
      actions.push(configCheck.action);
    }
  } else if (!notebookUrlConfigured && !oauthOk) {
    warnings.push(
      "No Drive notebook copy URL configured for default account; 'up' will use the GitHub bootstrap notebook with clipboard paste.",
    );
  }

  // When Google OAuth is connected (Tailscale-free Direct API mode), remove Tailscale actions.
  const effectiveActions = oauthOk
    ? actions.filter((a) => !a.includes("Tailscale") && !a.includes("tailscale"))
    : actions;

  const ok =
    nodeCheck.ok &&
    gitCheck.ok &&
    (oauthOk ||
      (tailscaleCheck.ok &&
        sshCheck.ok &&
        sshKeygenCheck.ok &&
        configCheck.ok));

  const mode =
    oauthOk && !configOk
      ? "direct-api"
      : configOk
        ? "tailscale-ssh"
        : "unconfigured";

  return {
    ok,
    mode,
    policy,
    checks: {
      node: nodeCheck,
      oauth: oauthCheck,
      tailscale: tailscaleCheck,
      ssh: sshCheck,
      sshKeygen: sshKeygenCheck,
      rsync: rsyncCheck,
      git: gitCheck,
      clipboard: clipboardCheck,
      config: configCheck,
    },
    actions: effectiveActions,
    warnings,
  };
}
