import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

const KNOWN_TAILSCALE_PATHS = {
  darwin: [
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ],
  linux: [
    "/usr/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/sbin/tailscale",
  ],
  win32: [
    "C:\\Program Files\\Tailscale\\tailscale.exe",
    "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
  ],
};

function isExecutableFile(filePath, platform = process.platform) {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (platform !== "win32") {
      accessSync(filePath, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export function findExecutableOnPath(
  name,
  { env = process.env, platform = process.platform } = {},
) {
  const pathEnv = env?.PATH ?? env?.Path ?? "";
  if (!pathEnv) {
    return null;
  }
  const dirs = pathEnv.split(platform === "win32" ? ";" : path.delimiter).filter(Boolean);
  const extensions =
    platform === "win32"
      ? name.toLowerCase().endsWith(".exe")
        ? [""]
        : [".exe", ".cmd", ".bat", ""]
      : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (isExecutableFile(candidate, platform)) {
        return candidate;
      }
    }
  }
  return null;
}

export function locateTailscaleBinary({
  env = process.env,
  platform = process.platform,
  extraCandidates = [],
} = {}) {
  const fromPath = findExecutableOnPath("tailscale", { env, platform });
  if (fromPath) {
    return fromPath;
  }
  const candidates = [
    ...extraCandidates,
    ...(KNOWN_TAILSCALE_PATHS[platform] ?? []),
  ];
  for (const candidate of candidates) {
    if (isExecutableFile(candidate, platform)) {
      return candidate;
    }
  }
  return null;
}

function firstIpv4(ips) {
  if (!Array.isArray(ips)) {
    return null;
  }
  return ips.find((ip) => typeof ip === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
}

function normalizePeer(raw) {
  const tailscaleIPs = Array.isArray(raw?.TailscaleIPs) ? raw.TailscaleIPs : [];
  const dnsName = typeof raw?.DNSName === "string" ? raw.DNSName : "";
  const dnsShort = dnsName ? dnsName.split(".")[0] : "";
  const rawHostName = typeof raw?.HostName === "string" ? raw.HostName : "";
  const hostName =
    rawHostName && rawHostName !== "localhost"
      ? rawHostName
      : dnsShort || rawHostName;

  return {
    id: raw?.ID ?? null,
    hostName,
    dnsName,
    tailscaleIPs,
    ipv4: firstIpv4(tailscaleIPs),
    online: Boolean(raw?.Online),
    active: Boolean(raw?.Active),
    tags: Array.isArray(raw?.Tags) ? raw.Tags : [],
  };
}

export function parseTailscaleStatus(input) {
  const raw = typeof input === "string" ? JSON.parse(input) : input;
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid tailscale status JSON");
  }
  const backendState =
    typeof raw.BackendState === "string" ? raw.BackendState : "Unknown";
  const self = raw.Self ? normalizePeer(raw.Self) : null;
  const peerMap = raw.Peer && typeof raw.Peer === "object" ? raw.Peer : {};
  const peers = Object.values(peerMap).map(normalizePeer);
  const tailnetName =
    raw.CurrentTailnet?.Name ??
    (typeof raw.MagicDNSSuffix === "string" && raw.MagicDNSSuffix
      ? raw.MagicDNSSuffix
      : null);

  return {
    backendState,
    loggedIn: backendState === "Running",
    tailnetName,
    self,
    peers,
  };
}

export function getTailscaleStatus({
  binaryPath = null,
  env = process.env,
  platform = process.platform,
  runCommand = null,
} = {}) {
  const resolvedBinary = binaryPath ?? locateTailscaleBinary({ env, platform });
  if (!resolvedBinary) {
    return {
      found: false,
      binaryPath: null,
      backendState: "NotInstalled",
      loggedIn: false,
      tailnetName: null,
      self: null,
      peers: [],
    };
  }

  const exec =
    runCommand ??
    ((file, args) =>
      execFileSync(file, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      }));

  const stdout = exec(resolvedBinary, ["status", "--json"]);
  const parsed = parseTailscaleStatus(stdout);
  return {
    found: true,
    binaryPath: resolvedBinary,
    ...parsed,
  };
}
