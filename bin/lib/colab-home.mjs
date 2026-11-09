import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveColabHome(homeDir = os.homedir()) {
  return path.join(homeDir, ".orca-colab");
}

export function getColabPaths(homeDir = os.homedir()) {
  const baseDir = resolveColabHome(homeDir);
  return {
    baseDir,
    configPath: path.join(baseDir, "config.json"),
    oauthPath: path.join(baseDir, "google-oauth.json"),
    privateKeyPath: path.join(baseDir, "id_ed25519"),
    publicKeyPath: path.join(baseDir, "id_ed25519.pub"),
    knownHostsPath: path.join(baseDir, "known_hosts"),
    sessionsDir: path.join(baseDir, "sessions"),
    tasksDir: path.join(baseDir, "tasks"),
    ledgerPath: path.join(baseDir, "ledger.jsonl"),
    ratesPath: path.join(baseDir, "rates.json"),
  };
}

export function ensureColabHome(homeDir = os.homedir()) {
  const paths = getColabPaths(homeDir);
  mkdirSync(paths.baseDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.baseDir, 0o700);
  mkdirSync(paths.sessionsDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.sessionsDir, 0o700);
  return paths;
}

export function writeJsonAtomic(filePath, value, { mode = 0o600 } = {}) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const tmpPath = `${filePath}.${suffix}`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    writeFileSync(tmpPath, serialized, { encoding: "utf8", mode });
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup error when write failed before file creation.
    }
    throw err;
  }
}

export function readJsonFile(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function normalizeConfig(input = {}) {
  const rawAccounts = Array.isArray(input.accounts) && input.accounts.length > 0
    ? input.accounts
    : [{ label: "default" }];

  const accounts = rawAccounts.map((acc) => {
    const entry = { label: String(acc?.label || "default") };
    if (typeof acc?.notebookUrl === "string" && acc.notebookUrl.trim() !== "") {
      entry.notebookUrl = acc.notebookUrl.trim();
    }
    return entry;
  });

  const defaultAccount =
    typeof input.defaultAccount === "string" && input.defaultAccount.trim() !== ""
      ? input.defaultAccount.trim()
      : accounts[0].label;

  const config = {
    authKey: typeof input.authKey === "string" ? input.authKey : "",
    authKeyCreatedAt:
      typeof input.authKeyCreatedAt === "string" ? input.authKeyCreatedAt : null,
    tags:
      Array.isArray(input.tags) && input.tags.length > 0
        ? input.tags.map(String)
        : ["tag:orca-colab"],
    remoteRootBase:
      typeof input.remoteRootBase === "string" && input.remoteRootBase.trim() !== ""
        ? input.remoteRootBase.trim()
        : "/content/orca",
    accounts,
    defaultAccount,
  };

  if (typeof input.loginServer === "string" && input.loginServer.trim() !== "") {
    config.loginServer = input.loginServer.trim();
  }

  return config;
}

export function readConfig(homeDir = os.homedir()) {
  const { configPath } = getColabPaths(homeDir);
  const parsed = readJsonFile(configPath);
  if (!parsed) {
    return null;
  }
  return normalizeConfig(parsed);
}

export function writeConfig(config, homeDir = os.homedir()) {
  const { configPath } = ensureColabHome(homeDir);
  const normalized = normalizeConfig(config);
  writeJsonAtomic(configPath, normalized, { mode: 0o600 });
  return normalized;
}

export function isValidAuthKey(authKey, loginServer = null) {
  if (typeof authKey !== "string") {
    return false;
  }
  const trimmed = authKey.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return false;
  }
  if (trimmed.startsWith("tskey-")) {
    return true;
  }
  if (loginServer && String(loginServer).trim() !== "") {
    return trimmed.length >= 16;
  }
  return false;
}

export function resolveAccount(config, requestedLabel) {
  const normalized = normalizeConfig(config ?? {});
  const label = requestedLabel || normalized.defaultAccount || "default";
  const found = normalized.accounts.find((a) => a.label === label);
  return found ?? { label };
}
