import { spawnSync } from "node:child_process";
import os from "node:os";
import { getColabPaths } from "./colab-home.mjs";

export function buildSshBaseArgs({
  homeDir = os.homedir(),
  extraArgs = [],
  tty = false,
} = {}) {
  const { privateKeyPath, knownHostsPath } = getColabPaths(homeDir);
  return [
    "-i",
    privateKeyPath,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "ConnectTimeout=10",
    ...(tty ? ["-tt"] : []),
    ...extraArgs,
  ];
}

export function buildSshExecArgs({
  ip,
  remoteCommand,
  homeDir = os.homedir(),
  tty = false,
  extraArgs = [],
}) {
  const cmdParts = Array.isArray(remoteCommand)
    ? remoteCommand
    : [String(remoteCommand)];
  return [
    ...buildSshBaseArgs({ homeDir, extraArgs, tty }),
    `root@${ip}`,
    ...cmdParts,
  ];
}

export function execSshCapture({
  ip,
  remoteCommand,
  homeDir = os.homedir(),
  timeoutMs = 15_000,
  runSsh = null,
}) {
  const args = buildSshExecArgs({ ip, remoteCommand, homeDir });
  if (runSsh) {
    return runSsh("ssh", args, { timeoutMs });
  }
  const res = spawnSync("ssh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

export function parseNvidiaSmiCsv(csvText) {
  if (typeof csvText !== "string") {
    return { name: "CPU", memoryMiB: 0 };
  }
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^name\s*,/i.test(line));

  if (lines.length === 0) {
    return { name: "CPU", memoryMiB: 0 };
  }

  const [rawName, rawMem] = lines[0].split(",").map((part) => part.trim());
  if (!rawName || /no devices were found|failed/i.test(rawName)) {
    return { name: "CPU", memoryMiB: 0 };
  }
  const memMatch = rawMem ? rawMem.match(/(\d+)/) : null;
  const memoryMiB = memMatch ? Number.parseInt(memMatch[1], 10) : 0;
  return {
    name: rawName,
    memoryMiB,
  };
}

export function queryRemoteGpu({
  ip,
  homeDir = os.homedir(),
  runSsh = null,
}) {
  const res = execSshCapture({
    ip,
    remoteCommand: "nvidia-smi --query-gpu=name,memory.total --format=csv",
    homeDir,
    runSsh,
  });
  if (res.status === 0 && res.stdout.trim()) {
    return parseNvidiaSmiCsv(res.stdout);
  }
  return { name: "CPU", memoryMiB: 0 };
}
